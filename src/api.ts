import { browserRequest } from "./browser/studio";

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  return await browserRequest(path,options) as T;
}

export const json = (body: unknown): RequestInit => ({
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
