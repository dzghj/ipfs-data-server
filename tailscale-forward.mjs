// Tiny local TCP forwarder: 127.0.0.1:<LISTEN_PORT> -> <tailnet host>:<port>,
// relayed through tailscaled's local SOCKS5 proxy (started in userspace mode
// by docker-entrypoint.sh, since this container has no TUN device / NET_ADMIN
// to run a real Tailscale network interface).
//
// This lets secure-share/ipfs-client.js talk to "127.0.0.1:5001" exactly as
// if Kubo were running in this same container — no code change there, and no
// public exposure of the Mac Mini's IPFS API at all.
import net from "net";
import { SocksClient } from "socks";

const LISTEN_PORT = Number(process.env.IPFS_FORWARD_LISTEN_PORT || 5001);
const TARGET_HOST = process.env.IPFS_TAILNET_HOST || "100.73.92.84";
const TARGET_PORT = Number(process.env.IPFS_TAILNET_PORT || 5001);
const SOCKS_PROXY = { host: "127.0.0.1", port: 1055, type: 5 };

const server = net.createServer(async (client) => {
  try {
    const { socket } = await SocksClient.createConnection({
      proxy: SOCKS_PROXY,
      command: "connect",
      destination: { host: TARGET_HOST, port: TARGET_PORT },
    });
    client.pipe(socket);
    socket.pipe(client);
    client.on("error", (err) => { console.error("[TS-FORWARD] client error:", err.message); socket.destroy(); });
    socket.on("error", (err) => { console.error("[TS-FORWARD] upstream error:", err.message); client.destroy(); });
  } catch (err) {
    console.error("[TS-FORWARD] connect failed:", err.message);
    client.destroy();
  }
});

server.on("error", (err) => console.error("[TS-FORWARD] server error:", err.message));

server.listen(LISTEN_PORT, "127.0.0.1", () => {
  console.log(`[TS-FORWARD] 127.0.0.1:${LISTEN_PORT} -> ${TARGET_HOST}:${TARGET_PORT} (via tailnet SOCKS proxy)`);
});
