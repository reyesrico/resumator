import { describe, expect, it } from "vitest";
import { fetchJobText, isPublicAddress } from "../server/job";

describe("public job URLs", () => {
  it.each(["127.0.0.1", "10.0.0.1", "192.168.0.1", "169.254.169.254", "::1", "::ffff:127.0.0.1", "0.0.0.0", "224.0.0.1", "100.64.0.1"])("rejects private or reserved IP %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
  it("allows ordinary public IP addresses", () => {
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });
  it("rejects unsupported protocols, credentials, and nonstandard ports before fetching", async () => {
    for (const url of ["file:///etc/passwd", "https://name:password@example.com", "https://example.com:8080/job"]) {
      await expect(fetchJobText(url)).rejects.toThrow("public HTTP");
    }
    await expect(fetchJobText("http://127.0.0.1/job")).rejects.toThrow("Private");
  });
});
