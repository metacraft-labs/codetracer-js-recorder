// No sleeps: each handler must await a recorded client turn before responding.
const http = require("node:http");
const { buildApp } = require("./app.js");
const markers = [];
function clientTurn(label) {
  return new Promise((resolve) => setImmediate(() => {
    markers.push(label);
    resolve();
  }));
}
function request(port, route) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: route, agent: false }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve([res.statusCode, JSON.parse(body).handler]));
    });
    req.on("error", reject);
  });
}
async function main() {
  const server = http.createServer(buildApp(clientTurn));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    const alpha = await request(port, "/alpha");
    const beta = await request(port, "/beta");
    if (JSON.stringify([alpha, beta, markers]) !== '[[200,"alpha"],[201,"beta"],["alpha","beta"]]') {
      throw new Error("mixed fixture did not drive both handlers and client turns");
    }
    console.log("MIXED_CLIENT_TURNS=alpha,beta");
  } finally {
    server.close();
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
