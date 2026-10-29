// Production build stand-in for the demo mock: the sample data never ships to the real panel.
export async function mockApi(): Promise<{ status: number; body: unknown }> {
  throw new Error('demo mock is not available in this build');
}
