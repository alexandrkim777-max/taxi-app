// Real builds: the demo mock is replaced by this stub (see metro.config.js).
export async function mockApi(): Promise<{ status: number; body: unknown }> {
  throw new Error('demo mock is not available in this build');
}
