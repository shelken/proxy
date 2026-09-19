// 最小 DNS 夹具：记录收到的查询域名，并固定答复。
//
// 用法：bun run dns-fixture.ts <port> <logPath>

const [portArg, logPath] = process.argv.slice(2);
if (!portArg || !logPath) {
  console.error("usage: dns-fixture.ts <port> <logPath>");
  process.exit(2);
}
const port: number = Number(portArg);

const seen: Set<string> = new Set();

/** 从查询报文里读出 QNAME。偏移 12 起是问题段。 */
function readQName(buf: Buffer): string {
  const labels: string[] = [];
  let offset = 12;
  while (offset < buf.length) {
    const len = buf[offset];
    if (len === 0 || len === undefined) break;
    labels.push(buf.subarray(offset + 1, offset + 1 + len).toString("ascii"));
    offset += len + 1;
  }
  return labels.join(".");
}

/** 构造一个 A 记录应答：回传原 ID，指回问题名的指针 0xC00C。 */
function buildResponse(query: Buffer, address: string): Buffer {
  const question = query.subarray(12);
  const header = Buffer.alloc(12);
  query.copy(header, 0, 0, 2); // 原 ID
  header.writeUInt16BE(0x8180, 2); // 标准应答，无错误
  header.writeUInt16BE(1, 4); // QDCOUNT
  header.writeUInt16BE(1, 6); // ANCOUNT

  const answer = Buffer.alloc(16);
  answer.writeUInt16BE(0xc00c, 0); // 指回问题名
  answer.writeUInt16BE(1, 2); // TYPE A
  answer.writeUInt16BE(1, 4); // CLASS IN
  answer.writeUInt32BE(60, 6); // TTL
  answer.writeUInt16BE(4, 10); // RDLENGTH
  address.split(".").forEach((part, i) => answer.writeUInt8(Number(part), 12 + i));

  return Buffer.concat([header, question, answer]);
}

const socket = Bun.udpSocket({
  port,
  hostname: "127.0.0.1",
  socket: {
    data(sock, data, senderPort, senderAddress) {
      const name = readQName(data);
      seen.add(name);
      void Bun.write(logPath, [...seen].join("\n") + "\n");
      const address = name.endsWith("zone.test") ? "192.0.2.1" : "192.0.2.99";
      sock.send(buildResponse(data, address), senderPort, senderAddress);
    },
  },
});

await Bun.write(`${logPath}.ready`, String(port));
console.log(`dns fixture listening on 127.0.0.1:${port}`);
