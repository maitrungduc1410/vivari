// Source for the "AWS S3" backend template, kept in one place because two
// consumers need the exact same bytes: the template registry (templates.ts) and
// the gate that proves it runs (scripts/spike-s3.mjs). Every other template
// duplicates its source into its spike; this app is far too big for that to stay
// honest, and a spike testing a stale copy is worse than no spike.
//
// Plain JS (not TS) so the headless spike can import it directly under Node.

/** The Express server: an S3 API the browser page drives. CommonJS. */
export const SERVER_JS = `const express = require('express');
const {
  S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const app = express();
const port = Number(process.env.PORT ?? 3000);

// Credentials live HERE, in this process's memory, for as long as the process
// runs. They are never written to the filesystem and never sent to the browser
// again. Reload the page and they survive (the server is still up); restart the
// server and they are gone. The secret key itself never leaves the sandbox: what
// goes on the wire is a SigV4 signature derived from it, plus the access key id.
let session = null;

const publicSession = () =>
  session && {
    bucket: session.bucket,
    region: session.region,
    endpoint: session.endpoint || null,
    accessKeyId: session.accessKeyId.slice(0, 4) + '…' + session.accessKeyId.slice(-4),
  };

function describe(e) {
  const name = (e && e.name) || 'Error';
  const message = (e && e.message) || String(e);
  let hint = null;
  // The failure everyone hits first. The request is made by the browser on your
  // behalf, so the bucket must allow this origin — same as any browser-side S3 app.
  if (/Failed to fetch|NetworkingError|TypeError|fetch failed/i.test(name + ' ' + message)) {
    hint = 'The browser blocked the request before it reached S3. Add the CORS policy shown on the page to your bucket.';
  } else if (/AccessDenied|InvalidAccessKeyId|SignatureDoesNotMatch/i.test(name)) {
    hint = 'S3 answered, so the network path works — this is the key, the secret, or the bucket policy.';
  } else if (/NoSuchBucket/i.test(name)) {
    hint = 'The bucket does not exist in that region.';
  }
  // Some responses (notably to HEAD requests) carry no body for the SDK to parse,
  // and it falls back to a nameless "UnknownError". The HTTP status is still
  // there, and it is the only actionable thing left — so say it.
  const status = e && e.$metadata && e.$metadata.httpStatusCode;
  if (status && /^Unknown/i.test(name)) {
    hint = 'S3 replied ' + status + ' with no error body' +
      (status === 403 ? ' — usually a bad secret, an expired key, or a bucket policy that denies you.' : '.');
  }
  return { error: name, message, hint, status: status || null };
}

const requireSession = (req, res, next) => {
  if (!session) return res.status(409).json({ error: 'NotConnected', message: 'Enter your credentials first.' });
  next();
};

app.use(express.json());

app.get('/api/session', (_req, res) => res.json({ connected: Boolean(session), session: publicSession() }));

// S3-compatible providers publish their endpoint without a scheme — DigitalOcean
// Spaces documents 'sgp1.digitaloceanspaces.com', and that is what lands in a
// .env. The SDK needs a URL, so a pasted host would fail on parsing rather than
// on anything the user could act on. Assume TLS, except on loopback where a local
// MinIO is almost always plain http.
// (Written without regex literals on purpose: this file is a template literal,
// so every backslash here would have to be doubled to survive into the app.)
function normalizeEndpoint(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  const lower = value.toLowerCase();
  if (lower.startsWith('http://') || lower.startsWith('https://')) return value;
  const host = lower.split('/')[0].split(':')[0];
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  return (loopback ? 'http://' : 'https://') + value;
}

app.post('/api/session', async (req, res) => {
  const { accessKeyId, secretAccessKey, region, bucket } = req.body || {};
  const endpoint = normalizeEndpoint((req.body || {}).endpoint);
  if (!accessKeyId || !secretAccessKey || !region || !bucket) {
    return res.status(400).json({ error: 'MissingFields', message: 'Access key, secret, region and bucket are all required.' });
  }
  const client = new S3Client({
    region,
    credentials: { accessKeyId, secretAccessKey },
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
  });
  try {
    // Probe with a 1-key list rather than HeadBucket: a HEAD has no response
    // body, so S3 answers a bad signature with a bare 403 and the SDK can only
    // say "UnknownError". A GET carries the XML error, so the page can show
    // SignatureDoesNotMatch / InvalidAccessKeyId / NoSuchBucket by name. It also
    // checks the exact permission this app needs first: listing.
    await client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }));
    session = { client, bucket, region, endpoint, accessKeyId };
    res.json({ connected: true, session: publicSession() });
  } catch (e) {
    res.status(400).json(describe(e));
  }
});

app.delete('/api/session', (_req, res) => {
  session = null;
  res.json({ connected: false });
});

app.get('/api/objects', requireSession, async (req, res) => {
  try {
    const out = await session.client.send(new ListObjectsV2Command({
      Bucket: session.bucket,
      Prefix: req.query.prefix || undefined,
      MaxKeys: 200,
    }));
    res.json({
      objects: (out.Contents || []).map((o) => ({ key: o.Key, size: o.Size, modified: o.LastModified })),
      truncated: Boolean(out.IsTruncated),
    });
  } catch (e) { res.status(502).json(describe(e)); }
});

// Raw body: the page PUTs the file bytes straight through. lib-storage splits
// anything over the part size into a real multipart upload.
app.put('/api/objects', requireSession, express.raw({ type: '*/*', limit: '1gb' }), async (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).json({ error: 'MissingKey', message: 'key query parameter is required.' });
  // express.raw only claims a request that declares a content-type, so without
  // one req.body is still the empty object express.json left behind. Say that
  // plainly instead of letting the SDK complain about an unsupported Body.
  if (!Buffer.isBuffer(req.body)) {
    return res.status(400).json({
      error: 'MissingBody',
      message: 'Send the file bytes as the request body with a Content-Type header.',
    });
  }
  try {
    const upload = new Upload({
      client: session.client,
      params: {
        Bucket: session.bucket,
        Key: key,
        Body: req.body,
        ContentType: req.headers['content-type'] || 'application/octet-stream',
      },
      partSize: 5 * 1024 * 1024,
      queueSize: 2,
    });
    const out = await upload.done();
    res.json({ key, size: req.body.length, etag: out.ETag || null, multipart: req.body.length > 5 * 1024 * 1024 });
  } catch (e) { res.status(502).json(describe(e)); }
});

app.get('/api/objects/download', requireSession, async (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).json({ error: 'MissingKey', message: 'key query parameter is required.' });
  try {
    const out = await session.client.send(new GetObjectCommand({ Bucket: session.bucket, Key: key }));
    const bytes = Buffer.from(await out.Body.transformToByteArray());
    res.setHeader('Content-Type', out.ContentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="' + key.split('/').pop() + '"');
    res.send(bytes);
  } catch (e) { res.status(502).json(describe(e)); }
});

app.delete('/api/objects', requireSession, async (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).json({ error: 'MissingKey', message: 'key query parameter is required.' });
  try {
    await session.client.send(new DeleteObjectCommand({ Bucket: session.bucket, Key: key }));
    res.json({ deleted: key });
  } catch (e) { res.status(502).json(describe(e)); }
});

// A presigned URL carries its signature in the query string, so whoever opens it
// needs no credentials of their own.
app.post('/api/presign', requireSession, async (req, res) => {
  const { key, expiresIn } = req.body || {};
  if (!key) return res.status(400).json({ error: 'MissingKey', message: 'key is required.' });
  try {
    const url = await getSignedUrl(
      session.client,
      new GetObjectCommand({ Bucket: session.bucket, Key: key }),
      { expiresIn: Number(expiresIn) || 900 },
    );
    res.json({ url });
  } catch (e) { res.status(502).json(describe(e)); }
});

app.get('/', (_req, res) => { res.type('html').send(PAGE); });

app.listen(port, () => console.log('S3 explorer listening on http://localhost:' + port));
`;

/** The single-page UI. No build step: plain HTML + a little vanilla JS. */
export const PAGE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>S3 Explorer · Vivari</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body { margin: 0; font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
             background: #11131a; color: #e6e8ef; }
      main { max-width: 940px; margin: 0 auto; padding: 32px 20px 64px; }
      h1 { font-size: 22px; margin: 0 0 4px; }
      h2 { font-size: 15px; margin: 0 0 12px; color: #aab; font-weight: 600; }
      p.sub { margin: 0 0 24px; color: #8b90a0; }
      section { background: #171a24; border: 1px solid #232735; border-radius: 10px; padding: 18px; margin-bottom: 18px; }
      label { display: block; font-size: 12px; color: #9aa0b4; margin-bottom: 4px; }
      input { width: 100%; padding: 8px 10px; border-radius: 6px; border: 1px solid #2b3040;
              background: #0e1017; color: #e6e8ef; font: inherit; }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
      button { padding: 8px 14px; border-radius: 6px; border: 1px solid #2f6df6; cursor: pointer;
               background: #2f6df6; color: #fff; font: inherit; border-color: #2f6df6; }
      button.ghost { background: transparent; color: #cbd0e0; border-color: #333949; }
      button:disabled { opacity: .5; cursor: default; }
      table { width: 100%; border-collapse: collapse; margin-top: 6px; }
      th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid #232735; font-size: 13px; }
      th { color: #8b90a0; font-weight: 600; }
      code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
      pre { background: #0e1017; border: 1px solid #232735; border-radius: 8px; padding: 12px; overflow: auto; }
      .note { border-left: 3px solid #f0a500; padding-left: 12px; color: #cfc7b0; }
      .err { color: #ff8080; white-space: pre-wrap; }
      .ok { color: #6ee7a8; }
      .muted { color: #7d8296; }
      details summary { cursor: pointer; color: #9aa0b4; }
    </style>
  </head>
  <body>
    <main>
      <h1>S3 Explorer</h1>
      <p class="sub">The real AWS SDK v3, running on Node inside your browser. List, upload, download and presign — against your own bucket.</p>

      <section>
        <h2>Credentials</h2>
        <p class="note" style="margin-top:0">
          These stay in this sandbox: the server process holds them in memory, nothing is written to disk,
          and the secret key never goes on the wire — only a SigV4 signature derived from it. They are gone
          when the server restarts. You are running your own keys on your own machine; treat them accordingly.
        </p>
        <div class="grid" style="margin-top:14px">
          <div><label>Access key ID</label><input id="ak" placeholder="AKIA…" autocomplete="off" spellcheck="false" /></div>
          <div><label>Secret access key</label><input id="sk" type="password" autocomplete="off" spellcheck="false" /></div>
          <div><label>Region</label><input id="region" value="us-east-1" spellcheck="false" /></div>
          <div><label>Bucket <span class="muted">— a Space's name on DigitalOcean</span></label><input id="bucket" placeholder="my-bucket" spellcheck="false" /></div>
          <div style="grid-column: 1 / -1">
            <label>Endpoint <span class="muted">— optional; set it for DigitalOcean Spaces, MinIO or any other S3-compatible server</span></label>
            <input id="endpoint" placeholder="sgp1.digitaloceanspaces.com" spellcheck="false" />
            <p class="muted" style="margin:6px 0 0">
              Paste the host as your provider publishes it — https:// is assumed. On DigitalOcean the
              region is the datacenter in that host: <code>sgp1.digitaloceanspaces.com</code> → region
              <code>sgp1</code>, and the Space name is the bucket.
            </p>
          </div>
        </div>
        <div class="row" style="margin-top:14px">
          <button id="connect">Connect</button>
          <button id="disconnect" class="ghost" hidden>Forget credentials</button>
          <span id="status" class="muted"></span>
        </div>
      </section>

      <section>
        <details>
          <summary>Your bucket needs a CORS policy — why, and what to paste</summary>
          <p style="margin-top:12px">
            This server runs inside a browser tab, so the request to S3 is ultimately made by the browser
            and is subject to CORS, exactly like any browser-side S3 app. Without this policy the first
            call fails before it reaches AWS. Paste it into <em>Bucket → Permissions → CORS</em>:
          </p>
          <pre id="corsjson"></pre>
        </details>
      </section>

      <section id="browser" hidden>
        <h2>Objects</h2>
        <div class="row">
          <input id="prefix" placeholder="filter by prefix" style="flex:1; min-width:200px" />
          <button id="refresh" class="ghost">Refresh</button>
          <label style="margin:0">
            <input type="file" id="file" hidden />
            <button id="pick">Upload a file…</button>
          </label>
        </div>
        <div id="uploadstatus" class="muted" style="margin-top:8px"></div>
        <table>
          <thead><tr><th>Key</th><th style="width:110px">Size</th><th style="width:200px">Modified</th><th style="width:210px"></th></tr></thead>
          <tbody id="rows"><tr><td colspan="4" class="muted">Not loaded yet.</td></tr></tbody>
        </table>
      </section>

      <p id="error" class="err"></p>
    </main>

    <script>
      const $ = (id) => document.getElementById(id);
      const showError = (d) => {
        $('error').textContent = d ? (d.error + ': ' + d.message + (d.hint ? '\\n\\n' + d.hint : '')) : '';
      };
      const fmtSize = (n) =>
        n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';

      $('corsjson').textContent = JSON.stringify([{
        AllowedHeaders: ['*'],
        AllowedMethods: ['GET', 'PUT', 'POST', 'DELETE', 'HEAD'],
        AllowedOrigins: [location.origin],
        ExposeHeaders: ['ETag', 'x-amz-request-id'],
        MaxAgeSeconds: 3000,
      }], null, 2);

      async function api(path, opts) {
        const res = await fetch(path, opts);
        const isJson = (res.headers.get('content-type') || '').includes('json');
        const body = isJson ? await res.json() : null;
        if (!res.ok) { showError(body || { error: 'HTTP ' + res.status, message: res.statusText }); throw new Error('request failed'); }
        showError(null);
        return body;
      }

      function setConnected(s) {
        $('browser').hidden = !s;
        $('disconnect').hidden = !s;
        $('status').textContent = s ? 'connected as ' + s.accessKeyId + ' · ' + s.bucket + ' (' + s.region + ')' : '';
        $('status').className = s ? 'ok' : 'muted';
      }

      $('connect').onclick = async () => {
        $('connect').disabled = true;
        try {
          const r = await api('/api/session', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              accessKeyId: $('ak').value.trim(), secretAccessKey: $('sk').value,
              region: $('region').value.trim(), bucket: $('bucket').value.trim(),
              endpoint: $('endpoint').value.trim(),
            }),
          });
          setConnected(r.session);
          await refresh();
        } catch {} finally { $('connect').disabled = false; }
      };

      $('disconnect').onclick = async () => {
        await api('/api/session', { method: 'DELETE' });
        setConnected(null);
        $('sk').value = '';
      };

      async function refresh() {
        const q = $('prefix').value.trim();
        const r = await api('/api/objects' + (q ? '?prefix=' + encodeURIComponent(q) : ''));
        const rows = $('rows');
        rows.innerHTML = '';
        if (!r.objects.length) { rows.innerHTML = '<tr><td colspan="4" class="muted">Empty.</td></tr>'; return; }
        for (const o of r.objects) {
          const tr = document.createElement('tr');
          const when = o.modified ? new Date(o.modified).toLocaleString() : '';
          tr.innerHTML = '<td><code></code></td><td>' + fmtSize(o.size) + '</td><td class="muted">' + when + '</td>';
          tr.querySelector('code').textContent = o.key;
          const td = document.createElement('td');
          td.className = 'row';
          const dl = document.createElement('button'); dl.className = 'ghost'; dl.textContent = 'Download';
          dl.onclick = () => { location.href = '/api/objects/download?key=' + encodeURIComponent(o.key); };
          const ln = document.createElement('button'); ln.className = 'ghost'; ln.textContent = 'Link';
          ln.onclick = async () => {
            const { url } = await api('/api/presign', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ key: o.key, expiresIn: 900 }),
            });
            await navigator.clipboard?.writeText(url).catch(() => {});
            ln.textContent = 'Copied';
            setTimeout(() => { ln.textContent = 'Link'; }, 1500);
          };
          const rm = document.createElement('button'); rm.className = 'ghost'; rm.textContent = 'Delete';
          rm.onclick = async () => {
            await api('/api/objects?key=' + encodeURIComponent(o.key), { method: 'DELETE' });
            await refresh();
          };
          td.append(dl, ln, rm);
          tr.append(td);
          rows.append(tr);
        }
      }

      $('refresh').onclick = () => refresh().catch(() => {});
      $('prefix').onkeydown = (e) => { if (e.key === 'Enter') refresh().catch(() => {}); };
      $('pick').onclick = () => $('file').click();
      $('file').onchange = async () => {
        const f = $('file').files[0];
        if (!f) return;
        $('uploadstatus').textContent = 'Uploading ' + f.name + ' (' + fmtSize(f.size) + ')…';
        try {
          const r = await api('/api/objects?key=' + encodeURIComponent(f.name), {
            method: 'PUT',
            headers: { 'content-type': f.type || 'application/octet-stream' },
            body: f,
          });
          $('uploadstatus').textContent = 'Uploaded ' + r.key + (r.multipart ? ' (multipart)' : '') + '.';
          await refresh();
        } catch { $('uploadstatus').textContent = ''; }
        $('file').value = '';
      };

      api('/api/session').then((r) => { if (r.connected) { setConnected(r.session); refresh().catch(() => {}); } }).catch(() => {});
    </script>
  </body>
</html>
`;

export const PACKAGE_JSON = `{
  "name": "s3-explorer",
  "private": true,
  "version": "1.0.0",
  "type": "commonjs",
  "scripts": { "start": "node src/server.js", "dev": "node src/server.js" },
  "dependencies": {
    "express": "^4.21.0",
    "@aws-sdk/client-s3": "^3.700.0",
    "@aws-sdk/lib-storage": "^3.700.0",
    "@aws-sdk/s3-request-presigner": "^3.700.0"
  }
}
`;

export const README_MD = `# S3 Explorer

The real \`@aws-sdk/client-s3\` v3, running on Node inside a browser tab. It lists, uploads
(multipart above 5 MB), downloads, deletes and presigns against a bucket you own.

## Credentials

The page asks for them and the server keeps them in memory only — never on disk, never sent
back to the page. The secret itself never leaves the sandbox: what goes on the wire is the
SigV4 signature derived from it, plus the access key id, exactly as the AWS CLI would send.
They are gone when the server restarts.

## Your bucket needs a CORS policy

This is the one piece that is not optional, and it is not a Vivari limitation: the server runs
in a browser tab, so the request to S3 is ultimately issued by the browser and is subject to
CORS like any browser-side S3 app. Put this on the bucket (Permissions → CORS), with
\`AllowedOrigins\` set to the origin the studio is served from:

\`\`\`json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "PUT", "POST", "DELETE", "HEAD"],
    "AllowedOrigins": ["https://your-studio-origin"],
    "ExposeHeaders": ["ETag", "x-amz-request-id"],
    "MaxAgeSeconds": 3000
  }
]
\`\`\`

Without it the first call fails before it reaches AWS, and the page says so.

## S3-compatible servers

Leave *Endpoint* blank for AWS. Point it at DigitalOcean Spaces, MinIO or another S3-compatible
server to use that instead — the client switches to path-style addressing automatically. Paste the
host exactly as the provider publishes it; \`https://\` is assumed when you leave the scheme off
(\`http://\` for localhost, where a MinIO usually runs without TLS).

**DigitalOcean Spaces.** Its API is S3, so the fields map one to one:

| Spaces | This app |
| --- | --- |
| \`DO_ACCESS_KEY_ID\` | Access key ID |
| \`DO_SECRET_ACCESS_KEY\` | Secret access key |
| \`DO_SPACE_NAME\` | Bucket |
| \`DO_SPACE_ENDPOINT\` | Endpoint |
| the datacenter inside that endpoint | Region |

So \`sgp1.digitaloceanspaces.com\` means the region is \`sgp1\`. The CORS policy above goes in the
Space's own settings (Settings → CORS Configurations) rather than a bucket policy.
`;

/** relPath -> contents, shared by the template registry and the spike. */
export function s3AppFiles() {
  return {
    "package.json": PACKAGE_JSON,
    "src/server.js": `const PAGE = ${JSON.stringify(PAGE_HTML)};\n\n${SERVER_JS}`,
    "README.md": README_MD,
  };
}