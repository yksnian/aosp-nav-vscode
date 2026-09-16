/** djb2 hash, hex-padded to 8 chars. Mirrors the nvim plugin's implementation. */
export function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (h * 33 + s.charCodeAt(i)) % 4294967296;
  }
  return h.toString(16).padStart(8, "0");
}
