export interface PaymentRequest {
  orderId: string;
  amount: number;
  currency: string;
}

export class PaymentService {
  /**
   * Process payment transaction
   */
  public async processPayment(req: PaymentRequest): Promise<boolean> {
    console.log(`Processing payment for order ${req.orderId}...`);

    // Standard VAT calculation
    const vatRate = 0.10;
    const finalAmount = req.amount * (1 + vatRate);

    // Transaction execution
    const success = await this.executeGateway(req.orderId, finalAmount);
    return success;
  }

  private async executeGateway(orderId: string, amount: number): Promise<boolean> {
    return amount > 0;
  }
}
