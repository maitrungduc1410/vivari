// Spike (NETWORK): prove the GraphQL (Yoga) Backend template boots and serves a
// real GraphQL API + demo UI in-VM. Mirrors the shipped `graphql` template in
// packages/studio/src/oc/templates.ts.
// Gates: install ok, `node src/index.js` binds :4000, GET / serves the demo UI,
// POST /graphql answers hello + greet(name) + books, and the addBook mutation
// actually mutates (books grows by one).
//   run (Node 22+):  node scripts/spike-graphql.mjs   (needs vendored npm — see spike-harness)
import { bootSpikeKernel, writeProject, npmInstall, waitListen, httpGet, httpPost } from "./lib/spike-harness.mjs";

const DIR = "/graphql";
const PORT = Number(process.env.OC_PORT || 4000);
const h = await bootSpikeKernel();

writeProject(h.kernel, DIR, {
  "package.json": `{
  "name": "graphql-app",
  "private": true,
  "version": "1.0.0",
  "type": "commonjs",
  "scripts": { "start": "node src/index.js", "dev": "node src/index.js" },
  "dependencies": { "graphql": "^16.10.0", "graphql-yoga": "^5.10.0" }
}
`,
  "src/index.js": `const { createServer } = require('node:http');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { createYoga, createSchema } = require('graphql-yoga');

let nextId = 3;
const books = [
  { id: '1', title: 'The Pragmatic Programmer', author: 'Hunt & Thomas' },
  { id: '2', title: 'Refactoring', author: 'Martin Fowler' },
];

const yoga = createYoga({
  graphqlEndpoint: '/graphql',
  schema: createSchema({
    typeDefs: \`
      type Book { id: ID!, title: String!, author: String! }
      type Query { hello: String, greet(name: String!): String, books: [Book!]! }
      type Mutation { addBook(title: String!, author: String!): Book! }
    \`,
    resolvers: {
      Query: {
        hello: () => 'Hello from GraphQL Yoga!',
        greet: (_p, args) => 'Hello ' + args.name + '!',
        books: () => books,
      },
      Mutation: {
        addBook: (_p, args) => {
          const book = { id: String(nextId++), title: args.title, author: args.author };
          books.push(book);
          return book;
        },
      },
    },
  }),
});

const indexHtml = readFileSync(path.join(__dirname, '..', 'public', 'index.html'));
const port = Number(process.env.PORT ?? ${PORT});
createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (req.method === 'GET' && url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(indexHtml);
    return;
  }
  return yoga(req, res);
}).listen(port, () => console.log('GraphQL demo on http://localhost:' + port));
`,
  "public/index.html": `<!doctype html><html><head><meta charset="UTF-8"><title>GraphQL demo</title></head>
<body><h1>GraphQL (Yoga)</h1><p>Demo UI. GraphiQL at /graphql.</p></body></html>
`,
});

const inst = await npmInstall(h, { dir: DIR });
if (inst.code !== 0) process.exit(1);
if (process.env.OC_INSTALL_ONLY === "1") process.exit(0);

const bound = await waitListen(h, { dir: DIR, port: PORT, argv: ["src/index.js"] });

let uiOk = false;
let helloOk = false;
let greetOk = false;
let booksOk = false;
let mutationOk = false;

if (bound) {
  const ui = await httpGet(h.kernel, PORT, "/");
  uiOk = ui.status === 200 && /GraphQL/.test(ui.body);
  console.log(`  GET / -> ${ui.status}  ${/GraphQL/.test(ui.body) ? "(demo UI)" : ui.body.slice(0, 80)}`);

  const hello = await httpPost(h.kernel, PORT, "/graphql", { query: "{ hello }" });
  helloOk = hello.status === 200 && /Hello from GraphQL Yoga/.test(hello.body);
  console.log(`  POST { hello } -> ${hello.status}  ${hello.body.slice(0, 100)}`);

  const greet = await httpPost(h.kernel, PORT, "/graphql", {
    query: "query($n:String!){ greet(name:$n) }",
    variables: { n: "Duc" },
  });
  greetOk = greet.status === 200 && /Hello Duc!/.test(greet.body);

  const before = await httpPost(h.kernel, PORT, "/graphql", { query: "{ books { id title author } }" });
  let n0 = -1;
  try { n0 = JSON.parse(before.body).data.books.length; } catch {}
  booksOk = before.status === 200 && n0 === 2 && /Pragmatic/.test(before.body);
  console.log(`  POST { books } -> ${before.status}  count=${n0}`);

  const add = await httpPost(h.kernel, PORT, "/graphql", {
    query: "mutation($t:String!,$a:String!){ addBook(title:$t,author:$a){ id title } }",
    variables: { t: "Dune", a: "Herbert" },
  });
  const after = await httpPost(h.kernel, PORT, "/graphql", { query: "{ books { id } }" });
  let n1 = -1;
  try { n1 = JSON.parse(after.body).data.books.length; } catch {}
  mutationOk = /"addBook"/.test(add.body) && /Dune/.test(add.body) && n1 === n0 + 1;
  console.log(`  POST addBook mutation -> ${add.status}  books ${n0} -> ${n1}`);
}

const ok = inst.code === 0 && bound && uiOk && helloOk && greetOk && booksOk && mutationOk;
console.log(
  "\nRESULT: " +
    (ok
      ? "PASS — GraphQL Yoga serves the demo UI + queries + a working mutation"
      : "FAIL — see logs above"),
);
process.exit(ok ? 0 : 1);
