import { ExclusionConfig, ScanEntry } from "./types";

export class FilterEngine {
  private jarRes: RegExp[];
  private pathKw: string[];
  private globRes: RegExp[];

  constructor(ex: ExclusionConfig) {
    this.jarRes = ex.jars.map(toRegex).filter((r): r is RegExp => r !== null);
    this.pathKw = ex.paths;
    this.globRes = ex.globs.map(toRegex).filter((r): r is RegExp => r !== null);
  }

  /** true = exclude this entry */
  hit(e: ScanEntry): boolean {
    const jarName = e.absPath.split(/[\\/]/).pop() ?? "";
    for (const re of this.jarRes) {
      if (re.test(jarName) || re.test(e.moduleName)) return true;
    }
    for (const kw of this.pathKw) {
      if (e.absPath.includes(kw)) return true;
    }
    for (const re of this.globRes) {
      if (re.test(e.relPath)) return true;
    }
    return false;
  }
}

function toRegex(src: string): RegExp | null {
  try {
    return new RegExp(src);
  } catch {
    // eslint-disable-next-line no-console
    console.warn(`[aosp-nav] invalid regex skipped: ${src}`);
    return null;
  }
}
