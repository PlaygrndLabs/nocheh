// Run one development Node service from the watched build: start it once a build has finished (dist/.dev-ready),
// restart it after each later finished build, and start it again whenever it exits on its own. `node --watch` waits
// for a file change after the process exits, which left a service down after a failed start until someone edited code.
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

/** One supervised Node process. Restarts after an exit it did not ask for wait 1 s, doubling to 30 s; a process that
 * ran longer than `settledAfter` before exiting starts the count again. */
export class DevProcess {
  #child;
  #exited = Promise.resolve();
  #asked = new WeakSet();
  #timer;
  #stopping = false;
  #delay;

  constructor(args, {name = args.join(' '), run = spawn, log = message => console.error(message), now = Date.now,
    stopAfter = 20000, firstDelay = 1000, maxDelay = 30000, settledAfter = 120000} = {}) {
    Object.assign(this, {args, name, run, log, now, stopAfter, firstDelay, maxDelay, settledAfter});
    this.#delay = firstDelay;
  }

  get running() { return !!this.#child; }

  /** Starts the process, unless it is running or a stop was asked. */
  start() {
    if (this.#stopping || this.#child) return;
    clearTimeout(this.#timer); this.#timer = undefined;
    const child = this.run(process.execPath, this.args, {stdio: 'inherit'}), started = this.now();
    let ended = false, done;
    this.#child = child;
    this.#exited = new Promise(resolve => { done = resolve; });
    const end = (code, signal) => {
      if (ended) return;
      ended = true; done();
      if (this.#child === child) this.#child = undefined;
      if (this.#stopping || this.#asked.has(child)) return;
      if (this.now() - started >= this.settledAfter) this.#delay = this.firstDelay;
      const delay = this.#delay;
      this.#delay = Math.min(delay * 2, this.maxDelay);
      this.log(`${this.name} exited (${signal || code}); starting it again in ${delay / 1000} s.`);
      this.#timer = setTimeout(() => { this.#timer = undefined; this.start(); }, delay);
    };
    child.on('exit', end);
    // Only a process that never started ends here; other errors (a failed signal) leave it running.
    child.on('error', error => {
      this.log(`${this.name}: ${error.message}`);
      if (child.pid === undefined) end(null, 'spawn failed');
    });
  }

  /** After a finished build: stops the running process, runs `stopped` (if given), then starts it on the new code at
   * once. A shutdown that hangs must not hold back the new code, so the process is killed after `stopAfter`. */
  async restart(stopped) {
    clearTimeout(this.#timer); this.#timer = undefined;
    this.#delay = this.firstDelay;
    await this.#halt(this.stopAfter);
    if (stopped) await stopped();
    this.start();
  }

  /** Stops the process for good. It gets all the time it needs to finish its work: the container's own stop grace
   * period, after which Docker kills everything, is the limit. */
  async stop() {
    this.#stopping = true;
    clearTimeout(this.#timer); this.#timer = undefined;
    await this.#halt(Infinity);
  }

  async #halt(limit) {
    const child = this.#child, exited = this.#exited;
    if (!child) return;
    this.#asked.add(child);
    child.kill('SIGTERM');
    const force = limit === Infinity ? undefined : setTimeout(() => {
      this.log(`${this.name} did not stop within ${limit / 1000} s; killing it.`);
      child.kill('SIGKILL');
    }, limit);
    await exited;
    clearTimeout(force);
  }
}

/** Calls `changed` with each new content of the build's ready marker, every 750 ms, until `stopped()`. */
export async function watchReady(marker, changed, stopped) {
  let seen;
  while (!stopped()) {
    const current = await readFile(marker, 'utf8').catch(() => undefined);
    if (current && current !== seen) {
      seen = current;
      await changed(current);
    }
    await new Promise(resolve => setTimeout(resolve, 750));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const entry = process.argv[2];
  if (!entry) {
    console.error('usage: dev-node-run.mjs <entry.js>');
    process.exit(2);
  }
  const service = new DevProcess([entry]);
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    stopping = true;
    void service.stop();
  });
  await watchReady('dist/.dev-ready', () => service.restart(), () => stopping);
}
