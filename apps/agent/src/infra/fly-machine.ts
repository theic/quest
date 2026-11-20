import { request } from "node:http";
import type { MachinePower } from "@mq/core";

/**
 * A Fly Machine suspending itself through the Machines API socket every machine
 * has at /.fly/api: no token needed for its own machine. A suspended machine
 * resumes in a few hundred milliseconds when Fly's proxy sends it a request.
 */
export class FlyMachine implements MachinePower {
  readonly canSleep = true;
  readonly #path: string;
  readonly #socket: string;

  constructor(app: string, machineId: string, socket = "/.fly/api") {
    this.#path = `/v1/apps/${encodeURIComponent(app)}/machines/${encodeURIComponent(machineId)}/suspend`;
    this.#socket = socket;
  }

  suspend(): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: this.#socket, host: "flaps", path: this.#path, method: "POST", timeout: 30_000 }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) resolve();
          else reject(new Error(`suspend answered ${status}: ${body.slice(0, 300)}`));
        });
      });
      req.on("timeout", () => req.destroy(new Error("suspend timed out")));
      req.on("error", reject);
      req.end();
    });
  }
}

/** Anywhere that is not a Fly Machine: the agent stays up. */
export const stayAwake: MachinePower = {
  canSleep: false,
  suspend: async () => undefined,
};
