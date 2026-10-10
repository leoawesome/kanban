// Stands in for interactive Claude Code in a PTY (`.../claude-code/cli.js --resume <id>`): leaves on /exit.
process.stdout.write("ready\n");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  if (/(^|\n)\/exit\n/.test(buf)) process.exit(0);
});
