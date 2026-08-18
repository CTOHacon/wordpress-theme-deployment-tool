// Standalone recursive uploader: local wp-content/uploads -> remote /wp-content/uploads
// Skips files that already exist remotely with the same size. Sequential fastPut.
import { Client } from "ssh2";
import config from "./config.theme.json";
import fs from "fs";
import path from "path";

const LOCAL_ROOT = path.resolve(import.meta.dir, "../../../uploads");
const REMOTE_ROOT = "/wp-content/uploads";

function collect(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === ".DS_Store") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...collect(full));
        else out.push(full);
    }
    return out;
}

const files = collect(LOCAL_ROOT);
console.log(`local files: ${files.length}`);

const c = new Client();
c.on("ready", () => {
    c.sftp(async (err, sftp) => {
        if (err) { console.error(err.message); process.exit(1); }

        const mkdir = (p: string) => new Promise<void>(res => sftp.mkdir(p, () => res()));
        const stat = (p: string) => new Promise<{ size: number } | null>(res =>
            sftp.stat(p, (e, s) => res(e ? null : { size: s.size })));
        const put = (l: string, r: string) => new Promise<void>((res, rej) =>
            sftp.fastPut(l, r, e => e ? rej(e) : res()));

        // Pre-create directory tree
        const dirs = new Set<string>();
        for (const f of files) {
            let rel = path.dirname(path.relative(LOCAL_ROOT, f));
            const parts = rel === "." ? [] : rel.split(path.sep);
            let cur = REMOTE_ROOT;
            for (const part of parts) {
                cur = cur + "/" + part;
                dirs.add(cur);
            }
        }
        for (const d of Array.from(dirs).sort()) await mkdir(d);
        console.log(`dirs ensured: ${dirs.size}`);

        let uploaded = 0, skipped = 0, failed = 0;
        for (const f of files) {
            const rel = path.relative(LOCAL_ROOT, f).split(path.sep).join("/");
            const remote = REMOTE_ROOT + "/" + rel;
            const localSize = fs.statSync(f).size;
            const r = await stat(remote);
            if (r && r.size === localSize) { skipped++; continue; }
            try {
                await put(f, remote);
                uploaded++;
            } catch (e: any) {
                failed++;
                console.error(`FAIL ${rel}: ${e.message}`);
            }
            if ((uploaded + skipped + failed) % 200 === 0)
                console.log(`progress: ${uploaded + skipped + failed}/${files.length} (up ${uploaded}, skip ${skipped}, fail ${failed})`);
        }
        console.log(`DONE: uploaded ${uploaded}, skipped ${skipped}, failed ${failed}`);
        c.end();
        process.exit(failed > 0 ? 1 : 0);
    });
}).on("error", e => { console.error("Connection error:", e.message); process.exit(1); })
.connect({
    host: config.ssh.host,
    port: config.ssh.port,
    username: config.ssh.username,
    password: config.ssh.password,
    keepaliveInterval: 10000
});
