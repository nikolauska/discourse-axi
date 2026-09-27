import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { operation } from "./errors.ts";

export const Metadata = z.object({
  issuer: z.string().url(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  authorization_response_iss_parameter_supported: z.boolean().optional(),
});
export const Pending = z.object({
  clientId: z.string(),
  redirect: z.string().url(),
  verifier: z.string(),
  state: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.number(),
  metadata: Metadata,
});
export const Grant = z.object({
  clientId: z.string(),
  redirect: z.string().url(),
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  expiresAt: z.number().optional(),
  scopes: z.array(z.string()),
  metadata: Metadata,
});
export const Entry = z.object({ pending: Pending.optional(), grant: Grant.optional() });
const Store = z.record(z.string(), Entry);
export type PendingLogin = z.infer<typeof Pending>;
export type StoredGrant = z.infer<typeof Grant>;
export type AuthEntry = z.infer<typeof Entry>;

export class TokenStore {
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }

  private async read() {
    try {
      const info = await lstat(this.path);
      if (!info.isFile() || info.isSymbolicLink())
        throw operation("Auth store must be a regular file");
      await chmod(this.path, 0o600);
      return Store.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
      throw operation("Cannot read the auth store safely", [
        "Check DISCOURSE_AXI_AUTH_FILE and its permissions; do not print its contents",
      ]);
    }
  }

  async get(resource: string): Promise<AuthEntry> {
    const data = await this.read();
    return Object.hasOwn(data, resource) ? data[resource] : {};
  }

  async update(resource: string, change: (entry: AuthEntry) => AuthEntry | undefined) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const lockPath = `${this.path}.lock`;
    let lock;
    try {
      lock = await open(lockPath, "wx", 0o600);
    } catch {
      throw operation("Auth store is locked", [
        "Wait for the other auth operation; remove the .lock file only if its process has stopped",
      ]);
    }
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const data = await this.read();
      const next = change(Object.hasOwn(data, resource) ? data[resource] : {});
      if (next) data[resource] = next;
      else delete data[resource];
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(data));
        await file.sync();
      } finally {
        await file.close();
      }
      // Readers see either complete version; a crash never leaves half a refresh token.
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
    } finally {
      await unlink(temporary).catch(() => undefined);
      await lock.close();
      await unlink(lockPath);
    }
  }
}
