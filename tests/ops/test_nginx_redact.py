import pathlib, re, shutil, subprocess, tempfile, unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
HTTP_CONF = ROOT / 'ops/nginx/tech-woman-redact-http.conf'
SERVER_CONF = ROOT / 'ops/nginx/tech-woman-redact-server.conf'
TOKEN = 'TEST-ONLY-tok_3n.VALUE-xyz'


def read(path):
    return path.read_bytes().decode('utf-8').replace(chr(13) + chr(10), chr(10))  # parsing only


def map_rules():
    """The (regex, template) pairs of `map $request_uri $tw_uri_redacted`, in file order, taken from the file."""
    text = read(HTTP_CONF)
    body = text.split('map $request_uri $tw_uri_redacted {', 1)[1].split('\n}', 1)[0]
    rules = []
    for line in body.splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        match = re.fullmatch(r'(default|~\*?)\s*(\S*)\s+"?([^";]*)"?;', line)
        if match is None:
            match = re.fullmatch(r'(default)\s+(\S+);', line)
            rules.append(('default', None, match.group(2)))
            continue
        kind, pattern, value = match.groups()
        if kind == 'default':
            rules.append(('default', None, pattern or value))
        else:
            rules.append((kind, pattern, value))
    return rules


def redact(uri):
    """Evaluate the map like nginx does: first matching regex wins; named captures fill the template."""
    for kind, pattern, template in map_rules():
        if kind == 'default':
            return uri if template == '$request_uri' else template
        flags = re.I if kind == '~*' else 0
        match = re.search(re.sub(r'\(\?<(\w+)>', r'(?P<\1>', pattern), uri, flags)
        if match:
            return re.sub(r'\$\{?(\w+)\}?', lambda m: match.groupdict().get(m.group(1), m.group(0)), template)
    return uri


class RedactionRuleTests(unittest.TestCase):
    def test_sensitive_paths_and_token_queries_never_reach_the_log_line(self):
        sensitive = [
            '/api/state/' + TOKEN, '/api/state/' + TOKEN + '?x=1', '/api/choice/' + TOKEN,
            '/api/choice/' + TOKEN + '/confirm', '/inscricao/estado/' + TOKEN, '/inscricao/estado/' + TOKEN + '?a=b',
            '/api/v1/auth/password/reset?token=' + TOKEN, '/api/v1/auth/password/reset/' + TOKEN,
            '/api/v1/auth/password/reset', '/qualquer/coisa?x=1&token=' + TOKEN, '/qualquer/coisa?token=' + TOKEN + '&y=2',
            '/qualquer/coisa?Token=' + TOKEN, '/a?b=c&TOKEN=' + TOKEN,
        ]
        for uri in sensitive:
            with self.subTest(uri=uri):
                self.assertNotIn(TOKEN, redact(uri))
                self.assertNotIn('tok_3n', redact(uri))

    def test_ordinary_requests_are_logged_untouched(self):
        for uri in ('/', '/agenda', '/api/v1/agenda/slots?cohort=2026', '/_next/static/chunk.js', '/inscricao',
                    '/api/state', '/inscricao/estado'):
            with self.subTest(uri=uri):
                self.assertEqual(redact(uri), uri)

    def test_the_redacted_form_keeps_the_route_for_diagnosis(self):
        self.assertTrue(redact('/api/state/' + TOKEN).startswith('/api/state/'))
        self.assertTrue(redact('/inscricao/estado/' + TOKEN).startswith('/inscricao/estado/'))
        self.assertTrue(redact('/qualquer/coisa?x=1&token=' + TOKEN).startswith('/qualquer/coisa'))


class ScopeAndSyntaxTests(unittest.TestCase):
    ALLOWED = {'map', 'default', 'log_format', 'access_log', 'error_log', 'location', 'include', 'proxy_set_header',
               'proxy_hide_header', 'add_header'}

    def test_files_touch_only_the_tech_woman_vhost_logs_and_never_restart_anything(self):
        for path in (HTTP_CONF, SERVER_CONF):
            text = read(path)
            code = '\n'.join(line for line in text.splitlines() if not line.strip().startswith('#'))
            for forbidden in ('http {', 'worker_', 'events', 'systemctl', 'nginx -s', 'reload', 'restart',
                              'upstream', 'ssl_certificate', 'listen '):
                self.assertNotIn(forbidden, code, path.name)
            self.assertEqual(re.findall(r'server_name\s+(\S+);', code), [])
            self.assertIsNone(re.search(r'^\s*user\s', code, re.M))
            self.assertEqual(code.count('{'), code.count('}'), path.name)
            for logfile in re.findall(r'(?:access_log|error_log)\s+(\S+)', code):
                self.assertTrue(logfile.startswith('/var/log/nginx/tech-woman') or logfile == '/dev/null', logfile)
        http_code = read(HTTP_CONF)
        self.assertNotIn('access_log', http_code.replace('# access_log', ''))
        self.assertNotIn('error_log', http_code.replace('# error_log', ''))
        self.assertIn('log_format tw_redacted', http_code)
        self.assertNotIn('$request_uri', http_code.split('log_format tw_redacted', 1)[1].split(';', 1)[0])
        self.assertNotIn('$http_referer', http_code.split('log_format tw_redacted', 1)[1].split(';', 1)[0])
        self.assertNotIn('$args', http_code.split('log_format tw_redacted', 1)[1].split(';', 1)[0])

    def test_server_snippet_logs_redacted_and_keeps_error_log_at_crit_with_a_sensitive_location(self):
        code = read(SERVER_CONF)
        self.assertRegex(code, r'access_log /var/log/nginx/tech-woman\.access\.log tw_redacted;')
        self.assertRegex(code, r'error_log /var/log/nginx/tech-woman\.error\.log crit;')
        location = re.search(r'location ~ (\S+) \{(.*?)\n\}', code, re.S)
        self.assertIsNotNone(location)
        for fragment in ('api/(?:state|choice)/', 'inscricao/estado/', 'api/v1/auth/password/reset'):
            self.assertIn(fragment, location.group(1))
        self.assertIn('error_log /dev/null crit;', location.group(2))
        self.assertIn('access_log /var/log/nginx/tech-woman.access.log tw_redacted;', location.group(2))

    def test_the_configuration_is_valid_for_a_real_nginx_when_one_is_available(self):
        runner = None
        if shutil.which('nginx'):
            runner = ['nginx']
        elif shutil.which('docker') and subprocess.run(['docker', 'image', 'inspect', 'nginx:alpine'],
                                                       capture_output=True).returncode == 0:
            runner = ['docker']
        if runner is None:
            self.assertTrue(HTTP_CONF.exists() and SERVER_CONF.exists())  # no nginx binary or local image here
            return
        with tempfile.TemporaryDirectory(prefix='tw-nginx-') as tmp:
            tmp = pathlib.Path(tmp)
            shutil.copy(HTTP_CONF, tmp / 'http.conf')
            shutil.copy(SERVER_CONF, tmp / 'server.conf')
            (tmp / 'tech-woman-proxy.conf').write_text('return 204;\n')
            (tmp / 'nginx.conf').write_text(
                'pid /tmp/nginx.pid;\nevents {}\nhttp {\n  access_log off;\n  include /etc/tw/http.conf;\n'
                '  server {\n    listen 8080;\n    server_name tech-woman.dellanio.com;\n'
                '    include /etc/tw/server.conf;\n    location / { return 204; }\n  }\n}\n')
            if runner == ['nginx']:
                text = (tmp / 'nginx.conf').read_text().replace('/etc/tw/', tmp.as_posix() + '/')
                (tmp / 'nginx.conf').write_text(text)
                server = (tmp / 'server.conf').read_text().replace('/etc/nginx/snippets/', tmp.as_posix() + '/')
                (tmp / 'server.conf').write_text(server)
                command = ['nginx', '-t', '-c', str(tmp / 'nginx.conf')]
            else:
                server = (tmp / 'server.conf').read_text().replace('/etc/nginx/snippets/', '/etc/tw/')
                (tmp / 'server.conf').write_text(server)
                command = ['docker', 'run', '--rm', '--network', 'none', '-v', '%s:/etc/tw:ro' % tmp,
                           '-v', '%s:/etc/nginx/nginx.conf:ro' % (tmp / 'nginx.conf'), 'nginx:alpine', 'nginx', '-t']
            done = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertIn('syntax is ok', done.stderr)


if __name__ == '__main__':
    unittest.main()
