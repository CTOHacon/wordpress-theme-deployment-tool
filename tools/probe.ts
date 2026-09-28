import { Client } from "ssh2";
import { connectOptions } from "./config";

const c = new Client();
c.on("ready", () => {
    c.sftp((err, sftp) => {
        if (err) { console.error("SFTP error:", err.message); process.exit(1); }
        sftp.realpath(".", (err, abs) => {
            console.log("realpath:", abs);
            sftp.readdir(abs || "/", (err, list) => {
                if (err) { console.error("readdir error:", err.message); process.exit(1); }
                console.log(list.map(f => f.filename).join("\n"));
                sftp.readdir((abs === "/" ? "" : abs) + "/wp-content/themes", (err2, l2) => {
                    if (err2) console.error("themes readdir:", err2.message);
                    else console.log("--- themes ---\n" + l2.map(f => f.filename).join("\n"));
                    c.end();
                });
            });
        });
    });
}).on("error", e => { console.error("Connection error:", e.message); process.exit(1); })
.connect(connectOptions());
