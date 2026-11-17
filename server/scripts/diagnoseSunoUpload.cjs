// Diagnostic only: original audio, free upload-source endpoint, read-only SQLite.
const fs = require('node:fs');
const path = require('node:path');
const dns = require('node:dns/promises');
const https = require('node:https');
const { createHash, randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');

const BASE = 'https://www.suno-api.io';
const HOST = 'www.suno-api.io';
const ENDPOINT = '/api/music/upload-source';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const log = (event, fields = {}) =>
  console.log(JSON.stringify({ utc: new Date().toISOString(), event, ...fields }));

function sourceOrder(contentId) {
  const db = new Database(path.resolve('data/app.db'), {
    readonly: true, fileMustExist: true, timeout: 3000
  });
  try {
    const job = db.prepare('SELECT * FROM music_jobs WHERE content_id=?').get(contentId);
    const content = db.prepare('SELECT cost,metadata FROM contents WHERE id=?').get(contentId);
    if (!job || !content || job.provider !== 'suno-api' || job.operation !== 'upload')
      throw new Error('仅支持已有的 suno-api 普通上传订单');
    const meta = JSON.parse(content.metadata || '{}');
    if (meta.billingStatus !== 'free' || meta.billingReservationId || Number(content.cost) !== 0)
      throw new Error('原订单不是免费上传');
    if (['queued', 'submitting', 'accepted'].includes(job.state) || job.lease_until > Date.now())
      throw new Error('原订单正在后台处理，请等该次处理结束后运行诊断');
    const channel = db.prepare('SELECT type,base_url,api_key FROM channels WHERE id=?').get(job.channel_id);
    const key = channel?.api_key?.trim();
    if (!key || channel.type !== 'suno-api' || channel.base_url?.trim().replace(/\/+$/, '') !== BASE ||
        sha256(JSON.stringify([BASE, key])) !== job.credential_hash)
      throw new Error('原渠道地址或原凭据不匹配');
    const spec = JSON.parse(job.payload);
    if (spec.endpoint !== ENDPOINT || !spec.multipart || !spec.request ||
        Object.keys(spec.request).some(name => !['model', 'file_name', 'upload_type'].includes(name)))
      throw new Error('原订单请求字段不符合普通上传协议');
    const filename = path.resolve(spec.multipart.file);
    const relative = path.relative(path.resolve('data/private-music'), filename);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('音频不在本站私有音乐目录');
    const stat = fs.statSync(filename);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 40 * 1024 * 1024)
      throw new Error('原音频不可用或超过 40 MB');
    return { job, spec, key, file: fs.readFileSync(filename) };
  } finally {
    db.close();
  }
}

function redact(value, key) {
  return String(value || '').split(key).join('[KEY]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [KEY]')
    .replace(/https?:\/\/\S+/g, '[URL]').slice(0, 700);
}

async function encode(source, format) {
  const { spec, file } = source;
  if (format === 'json_base64') {
    return {
      body: Buffer.from(JSON.stringify({ ...spec.request, file_base64: file.toString('base64') })),
      contentType: 'application/json'
    };
  }
  const form = new FormData();
  form.append('file', new Blob([file], { type: spec.multipart.mime }), spec.multipart.name);
  for (const [name, value] of Object.entries(spec.request)) form.append(name, String(value));
  const response = new Response(form);
  return { body: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get('content-type') };
}

async function probe(source, address, format, encoded) {
  const started = Date.now();
  const trace = 'suno-diag-' + randomUUID();
  let socket, bodySent = false;
  const report = (event, data = {}) => log(event, {
    contentId: source.job.content_id, trace, address, format, elapsedMs: Date.now() - started, ...data
  });
  report('REQUEST', {
    endpoint: ENDPOINT, audioBytes: source.file.length, audioSha256: sha256(source.file),
    bodyBytes: encoded.body.length, bodySha256: sha256(encoded.body), contentType: encoded.contentType
  });
  return new Promise(resolve => {
    let deadline, settled = false;
    function finish(event, data) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      report(event, data);
      resolve({ address, format, elapsedMs: Date.now() - started, ...data });
    }
    const request = https.request(BASE + ENDPOINT, {
      method: 'POST', agent: false, family: 4, servername: HOST,
      lookup(_hostname, options, callback) {
        if (options?.all) callback(null, [{ address, family: 4 }]);
        else callback(null, address, 4);
      },
      headers: {
        Authorization: 'Bearer ' + source.key,
        'Content-Type': encoded.contentType,
        'Content-Length': encoded.body.length,
        Connection: 'close',
        'X-Request-ID': trace
      }
    }, response => {
      report('HTTP_HEADERS', {
        http: response.statusCode, server: response.headers.server,
        requestId: response.headers['x-request-id'] || response.headers['x-oneapi-request-id'],
        contentType: response.headers['content-type']
      });
      let bytes = 0;
      const chunks = [];
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes <= 1024 * 1024) chunks.push(chunk);
        else response.destroy(new Error('诊断响应超过 1 MB'));
      });
      response.on('end', () => {
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
        finish('RESULT', {
          http: response.statusCode, responseBytes: bytes, json: Boolean(data),
          success: response.statusCode >= 200 && response.statusCode < 300 &&
            data?.success !== false && !data?.error && data?.status === 'complete' && Boolean(data?.clip_id),
          clipId: data?.clip_id, status: data?.status,
          code: redact(data?.error?.code ?? data?.code, source.key),
          message: redact(data?.error?.message ?? data?.message ?? data?.error_message, source.key)
        });
      });
      response.on('error', fail);
    });
    function fail(error) {
      finish('ERROR', {
        code: error.code || error.name, message: redact(error.message, source.key), bodySent,
        remoteAddress: socket?.remoteAddress,
        socketBytesWritten: socket?.bytesWritten, socketBytesRead: socket?.bytesRead
      });
    }
    deadline = setTimeout(() => request.destroy(
      Object.assign(new Error('本诊断达到 310 秒截止时间'), { code: 'DIAGNOSTIC_DEADLINE' })
    ), 310000);
    request.on('socket', value => {
      socket = value;
      socket.on('secureConnect', () => report('TLS_CONNECTED', {
        remoteAddress: socket.remoteAddress, localPort: socket.localPort,
        tls: socket.getProtocol(), authorized: socket.authorized
      }));
    });
    request.on('finish', () => {
      bodySent = true;
      report('BODY_SENT', { socketBytesWritten: socket?.bytesWritten });
    });
    request.on('error', fail);
    request.end(encoded.body);
  });
}

async function main() {
  const id = Number(process.env.SUNO_DIAG_CONTENT_ID || 16028);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('订单编号无效');
  const source = sourceOrder(id);
  const addresses = [...new Set((await dns.lookup(HOST, { family: 4, all: true })).map(item => item.address))].slice(0, 2);
  if (!addresses.length) throw new Error('没有查到上游 IPv4 地址');
  log('PLAN', {
    contentId: id, node: process.version, addresses, fields: Object.keys(source.spec.request),
    calls: addresses.length * 2,
    note: '固定同一 IP、原音频、原业务字段，比较 multipart 与 JSON base64；每组顺序交替；最多四次免费普通上传'
  });
  const bodies = {
    multipart: await encode(source, 'multipart'),
    json_base64: await encode(source, 'json_base64')
  };
  const results = [];
  for (const [index, address] of addresses.entries()) {
    const formats = index % 2 ? ['json_base64', 'multipart'] : ['multipart', 'json_base64'];
    for (const format of formats) results.push(await probe(source, address, format, bodies[format]));
  }
  log('SUMMARY', { results });
}
if (require.main === module || module.id === '[stdin]') {
  main().catch(error => {
    log('STOP', { code: error.code || error.name, message: String(error.message).replace(/https?:\/\/\S+/g, '[URL]').slice(0, 500) });
    process.exitCode = 1;
  });
}
module.exports = { sourceOrder, encode, probe };

