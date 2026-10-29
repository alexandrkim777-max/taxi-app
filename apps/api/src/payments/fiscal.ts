// Fiscal receipts for what we sell (driver subscriptions). STUB until we connect to the tax
// authority's online fiscal system (OFD / soliq.uz) through an approved operator.

export interface FiscalReceiptRequest {
  paymentId: string;
  amountTiyin: number;
  description: string;
  /** Payer phone, if the operator asks for it to send an electronic receipt. */
  phone?: string;
}

export interface FiscalProvider {
  readonly name: string;
  issue(req: FiscalReceiptRequest): Promise<{ receiptNumber: string; payload: unknown }>;
}

export class FakeFiscalProvider implements FiscalProvider {
  readonly name = 'fake';
  async issue(req: FiscalReceiptRequest): Promise<{ receiptNumber: string; payload: unknown }> {
    return { receiptNumber: `FAKE-${req.paymentId.slice(0, 8).toUpperCase()}`, payload: { test: true } };
  }
}
