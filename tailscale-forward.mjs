// Tiny local TCP forwarder: 127.0.0.1:<LISTEN_PORT> -> <tailnet host>:<port>,
// relayed through tailscaled's local SOCKS5 proxy (started in userspace mode
// by docker-entrypoint.sh, since this container has no TUN device / NET_ADMIN
// to run a real Tailscale network interface).
//
// This lets secure-share/ipfs-client.js talk to "127.0.0.1:5001" exactly as
// if Kubo were running in this same container — no code change there, and no
// public exposure of the Mac Mini's IPFS API at all. It also forwards the
// IPFS Cluster REST API (default :9094) so clusterPin() in secure-share/
// index.js can reach it via CLUSTER_API_URL=http://127.0.0.1:<port>.
import net from "net";
import { SocksClient } from "socks";

const TARGET_HOST = process.env.IPFS_TAILNET_HOST || "100.73.92.84";
const SOCKS_PROXY = { host: "127.0.0.1", port: 1055, type: 5 };

const FORWARDS = [
  {
    name: "IPFS API",
    listenPort: Number(process.env.IPFS_FORWARD_LISTEN_PORT || 5001),
    targetPort: Number(process.env.IPFS_TAILNET_PORT || 5001),
  },
  {
    name: "Cluster REST API",
    listenPort: Number(process.env.CLUSTER_FORWARD_LISTEN_PORT || 9094),
    targetPort: Number(process.env.CLUSTER_TAILNET_PORT || 9094),
  },
];

function startForward({ name, listenPort, targetPort }) {
  const server = net.createServer(async (client) => {
    try {
      const { socket } = await SocksClient.createConnection({
        proxy: SOCKS_PROXY,
        command: "connect",
        destination: { host: TARGET_HOST, port: targetPort },
      });
      client.pipe(socket);
      socket.pipe(client);
      client.on("error", (err) => { console.error(`[TS-FORWARD:${name}] client error:`, err.message); socket.destroy(); });
      socket.on("error", (err) => { console.error(`[TS-FORWARD:${name}] upstream error:`, err.message); client.destroy(); });
    } catch (err) {
      console.error(`[TS-FORWARD:${name}] connect failed:`, err.message);
      client.destroy();
    }
  });

  server.on("error", (err) => console.error(`[TS-FORWARD:${name}] server error:`, err.message));

  server.listen(listenPort, "127.0.0.1", () => {
    console.log(`[TS-FORWARD:${name}] 127.0.0.1:${listenPort} -> ${TARGET_HOST}:${targetPort} (via tailnet SOCKS proxy)`);
  });
}

for (const fwd of FORWARDS) {
  startForward(fwd);
}
