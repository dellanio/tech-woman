import assert from 'node:assert/strict';
import {test} from 'node:test';
import {errorResponse, HttpError, readJson} from '../../src/lib/auth';

const request = (body: string, type = 'application/json') => new Request('http://app.example.invalid', {method: 'POST', headers: {'Content-Type': type}, body});
const invalid = async (req: Request) => {
  await assert.rejects(readJson(req), (error: unknown) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.code, 'INVALID_JSON');
    const response = errorResponse(error);
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return true;
  });
};
// JSON string quotes cost two bytes; filler makes the exact requested UTF-8 size.
const sized = (size: number, char: string) => '"' + char.repeat(Math.floor((size - 2) / Buffer.byteLength(char))) + 'a'.repeat((size - 2) % Buffer.byteLength(char)) + '"';
for (const char of ['a', 'é', '🚀']) {
  for (const size of [65535, 65536, 65537]) {
    test(`readJson: ${Buffer.byteLength(char)}-byte UTF8, ${size} bytes`, async () => {
      const body = sized(size, char);
      assert.equal(Buffer.byteLength(body), size);
      if (size > 65536) await invalid(request(body));
      else assert.equal(await readJson(request(body)), JSON.parse(body));
    });
  }
}
test('readJson: malformed JSON and wrong/missing type retain INVALID_JSON', async () => {
  for (const body of ['{', '', 'null trailing']) await invalid(request(body));
  for (const type of ['', 'text/plain', 'application/jsonp']) await invalid(request('{}', type));
  assert.deepEqual(await readJson(request('{"ok":true}', 'Application/JSON; charset=utf-8')), {ok:true});
});

test('readJson: raw byte boundary, split UTF8 and misleading Content-Length', async () => {
  const bytes = new TextEncoder().encode(sized(65536, '🚀'));
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({pull(controller) {
    if (offset === bytes.length) return controller.close();
    controller.enqueue(bytes.slice(offset, ++offset));
  }});
  const req = new Request('http://app.example.invalid', {method:'POST', headers:{'Content-Type':'application/json','Content-Length':'1'}, body:stream, duplex:'half'} as RequestInit & {duplex:'half'});
  assert.equal(await readJson(req), JSON.parse(new TextDecoder().decode(bytes)));
});

test('readJson: stops reading and cancels oversized stream before its tail', async () => {
  let pulls = 0, cancelled = false;
  const stream = new ReadableStream<Uint8Array>({pull(controller) {
    pulls++;
    if (pulls <= 4) controller.enqueue(new Uint8Array(32768).fill(32));
    else controller.close();
  }, cancel() {cancelled = true;}});
  const req = new Request('http://app.example.invalid', {method:'POST', headers:{'Content-Type':'application/json','Content-Length':'1'}, body:stream, duplex:'half'} as RequestInit & {duplex:'half'});
  await invalid(req);
  assert.equal(cancelled, true);
  assert.ok(pulls <= 4, 'does not consume the entire body');
});
