// Separate from the API: a fix can restart the API without interrupting itself.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createFeedback } from './feedback.mjs';
import { runFeedback } from './server.mjs';
const dir=process.env.SERVANT_DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)),'data');
fs.mkdirSync(dir,{recursive:true,mode:0o700});
process.umask(0o077);
const queue=createFeedback({file:path.join(dir,'feedback.db'),run:runFeedback});
const keepAlive=setInterval(()=>{},60000);
void queue.tick();
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{clearInterval(keepAlive);queue.close();process.exit(0);});
