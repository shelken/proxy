// 最小 DNS 夹具：记录收到的查询域名，并固定答复。
//
// 用法：bun run dns-fixture.mjs <port> <logPath>
//
// 存在的理由：sing-box 不暴露「这次查询最终走了哪个上游」。用两个分别监听不同
// 端口的夹具，各自记录收到的域名，用互斥断言就能确定上游选择。

const [portArg, logPath] = process.argv.slice(2);
if (!portArg || !logPath) {
  console.error("usage: dns-fixture.mjs <port> <logPath>");
  process.exit(2);
}
const port = Number(portArg);

const seen = new Set();

/** 从查询报文里读出 QNAME。偏移 12 起是问题段。 */
function readQName(buf) {
  const labels = [];
  let offset = 12;
  while (offset < buf.length) {
    const len = buf[offset];
    if (len === 0) break;
    labels.push(buf.subarray(offset + 1, offset + 1 + len).toString("ascii"));
    offset += len + 1;
  }
  return labels.join(".");
}

/** 构造一个 A 记录应答：回传原 ID，指回问题名的指针 0xC00C。 */
function buildResponse(query, address) {
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
    // 注意参数名：这里的 senderPort/senderAddress 来自回调，是请求方（sing-box）
    // 的地址。不要用外层的 port，那是夹具自己的监听端口，发回去会形成自环。
    data(sock, data, senderPort, senderAddress) {
      const name = readQName(data);
      seen.add(name);
      // 整份覆写：测试用文件内容做断言，增量追加会读到上一轮的数据。
      void Bun.write(logPath, [...seen].join("\n") + "\n");
      const address = name.endsWith("zone.test") ? "192.0.2.1" : "192.0.2.99";
      sock.send(buildResponse(data, address), senderPort, senderAddress);
    },
  },
});

// 就绪信号：绑定失败会抛错，此时不写 ready，调用方会超时报错。
await Bun.write(`${logPath}.ready`, String(port));
console.log(`dns fixture listening on 127.0.0.1:${port}`);
