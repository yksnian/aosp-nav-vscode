/** Classpath injection channel abstraction (ADR-1).
 *  P0 ships settingsChannel as primary. projectFileChannel (.project/.classpath
 *  generation) is the designed fallback if spike S1 fails; interface reserved. */
export interface ClasspathChannel {
  readonly name: string;
  apply(root: string, jars: string[]): Promise<boolean>;
}
