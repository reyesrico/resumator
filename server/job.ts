import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import ipaddr from "ipaddr.js";
import { load } from "cheerio";
import { AppError } from "./errors.js";

export function isPublicAddress(address: string) {
  return ipaddr.isValid(address) && ipaddr.process(address).range() === "unicast";
}

export async function fetchJobText(rawUrl: string, redirects = 0): Promise<string> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new AppError(400, "Enter a valid public job-posting URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      (url.port && !["80", "443"].includes(url.port))) {
    throw new AppError(400, "Job links must be public HTTP or HTTPS URLs on standard ports.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let addresses;
  try { addresses = await lookup(hostname, { all: true }); }
  catch { throw new AppError(422, "The job website could not be resolved. Paste the description instead."); }
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new AppError(400, "Private, local, and reserved network addresses are not allowed.");
  }
  // Connect to the validated IP, not a second DNS resolution.
  const response = await new Promise<{ status: number; location?: string; body: string; contentType: string }>((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).get({
      hostname: addresses[0].address,
      servername: hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      headers: { Host: url.host, "User-Agent": "Resumator/0.1", Accept: "text/html,text/plain" },
    }, (result) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      result.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 2_000_000) {
          request.destroy(new AppError(422, "The job page is too large. Paste the description instead."));
          return;
        }
        chunks.push(chunk);
      });
      result.on("end", () => resolve({
        status: result.statusCode ?? 500, location: result.headers.location,
        body: Buffer.concat(chunks).toString("utf8"), contentType: result.headers["content-type"] ?? "",
      }));
      result.on("error", reject);
    });
    request.setTimeout(12_000, () => request.destroy(new AppError(422, "The job website timed out. Paste the description instead.")));
    request.on("error", reject);
  }).catch((error: unknown) => {
    if (error instanceof AppError) throw error;
    throw new AppError(422, "The job page could not be fetched. Paste the description instead.");
  });
  if (response.status >= 300 && response.status < 400 && response.location) {
    if (redirects >= 3) throw new AppError(422, "The job link redirects too many times. Paste the description instead.");
    return fetchJobText(new URL(response.location, url).href, redirects + 1);
  }
  if (response.status !== 200 || !/text\/(html|plain)/i.test(response.contentType)) {
    throw new AppError(422, "The job site blocked access or returned unsupported content. Paste the description instead.");
  }
  let text = response.body;
  if (/text\/html/i.test(response.contentType)) {
    const $ = load(text);
    $("script, style, nav, footer, header, noscript, svg, iframe, form").remove();
    text = ($("main").first().length ? $("main").first() : $("body")).text();
  }
  text = text.replace(/\s+/g, " ").trim();
  if (text.length < 100) throw new AppError(422, "The page does not contain enough readable job information. Paste the description instead.");
  return text.slice(0, 25_000);
}
