export interface PaymentRequest {
  orderId: string;
  amount: number;
  currency: string;
  usePoints?: boolean;
}

export class PaymentService {
  /**
   * Process payment transaction with Loyalty Points (Branch B by Bob)
   */
  public async processPayment(req: PaymentRequest): Promise<boolean> {
    console.log(`[Branch-B] Processing payment for order ${req.orderId} (Use Points: ${req.usePoints})...`);

    // Bob: Deduct 2,000 KRW points reward + 10% standard VAT
    const pointDeduction = req.usePoints ? 2000 : 0;
    const finalAmount = Math.max(0, req.amount - pointDeduction) * 1.10;

    // Transaction execution with Bob's payment gateway
    const success = await this.executeGateway(req.orderId, finalAmount);
    return success;
  }

  private async executeGateway(orderId: string, amount: number): Promise<boolean> {
    return amount > 0;
  }
}
