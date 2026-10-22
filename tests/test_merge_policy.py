import json, pathlib, subprocess, unittest
ROOT = pathlib.Path(__file__).resolve().parents[1]
class MergePolicyTests(unittest.TestCase):
    def test_trusted_ci_completion_exact_author_and_head(self):
        text = (ROOT / '.github/workflows/approved-merge.yml').read_text()
        for required in ['workflow_run:', 'workflows: [CI]', "run.event == 'pull_request'", "run.conclusion == 'success'", "pr.user.login == 'beatrizbenz'", "pr.base.ref == 'main'", 'pr.head.sha == run.head_sha', "'sha': run.head_sha", "'merge_method': 'squash'"]:
            self.assertIn(required, text)
        self.assertNotIn('actions/checkout', text)
        self.assertNotIn('secrets.', text)
        self.assertNotIn('--auto', text)
    def test_deploy_listens_to_trusted_merge(self):
        text = (ROOT / '.github/workflows/deploy.yml').read_text()
        self.assertIn('workflows: [Beatriz auto-merge]', text)
        self.assertIn('ref: main', text)
        self.assertNotIn('workflow_run.head_sha', text)
        self.assertIn("needs.gate.outputs.deploy == 'true'", text)
        self.assertIn('.name == "merge" and .conclusion == "success"', text)

    def test_actual_inline_policy_with_api_fixtures(self):
        text = (ROOT / '.github/workflows/approved-merge.yml').read_text()
        source = text.split("node <<'JS'\n", 1)[1].rsplit('\n          JS', 1)[0]
        source = '\n'.join(line[10:] for line in source.splitlines())
        harness = r'''
const data = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
let mutations = [];
const run = {event:'pull_request', conclusion:'success', path:'.github/workflows/ci.yml', repository:{full_name:'dellanio/tech-woman'}, head_sha:'tested', ...data.run};
const pr = {number:9, user:{login:'beatrizbenz'}, base:{ref:'main',repo:{full_name:'dellanio/tech-woman'}}, head:{sha:'tested'}, draft:false,state:'open', ...data.pr};
let reads = 0;
const mock = (cmd,args,opts) => {
  const path = args[1];
  if (args.includes('PUT')) { mutations.push(JSON.parse(opts.input)); return JSON.stringify({merged:true,sha:'merged'}); }
  if (path.includes('actions/runs/')) return JSON.stringify(run);
  if (path.includes('pulls?')) return JSON.stringify([pr]);
  reads++;
  if (mutations.length) return JSON.stringify({...pr,merged:true,merge_commit_sha:'merged'});
  return JSON.stringify(data.changed ? {...pr,head:{sha:'changed'}} : pr);
};
let error = null;
try { new Function('require','process','console',data.source)(() => ({execFileSync:mock}),{env:{GH_REPO:'dellanio/tech-woman',RUN_ID:'1'}},{log:()=>{}}); }
catch(e) {error = e.message;}
console.log(JSON.stringify({mutations,error}));
'''
        for case in [{}, {'pr':{'user':{'login':'dellanio'}}}, {'pr':{'head':{'sha':'stale'}}}, {'pr':{'draft':True}}, {'pr':{'base':{'ref':'other','repo':{'full_name':'dellanio/tech-woman'}}}}, {'run':{'conclusion':'failure'}}, {'run':{'event':'push'}}, {'run':{'path':'.github/workflows/evil.yml'}}, {'changed':True}]:
            with self.subTest(case=case):
                result = subprocess.run(['node','-e',harness], input=json.dumps({'source':source,**case}),text=True,capture_output=True,check=True)
                actual = json.loads(result.stdout)
                if not case:
                    self.assertIsNone(actual['error'])
                    self.assertEqual(actual['mutations'],[{'sha':'tested','merge_method':'squash'}])
                else:
                    self.assertTrue(actual['error'])
                    self.assertEqual(actual['mutations'],[])
