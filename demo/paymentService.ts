export interface PaymentRequest {
  orderId: string;
  amount: number;
  currency: string;
  voucherCode?: string;
}

export class PaymentService {
  /**
   * Process payment transaction with Discount Voucher (Branch A by Alice)
   */
  public async processPayment(req: PaymentRequest): Promise<boolean> {
    console.log(`[Branch-A] Processing payment for order ${req.orderId} with voucher ${req.voucherCode || 'NONE'}...`);

    // Alice: Apply 15% discount for spring sale + 10% VAT
    const discountRate = req.voucherCode === 'SPRING15' ? 0.15 : 0;
    const discountedAmount = req.amount * (1 - discountRate);
    const finalAmount = discountedAmount * 1.10;

    // Transaction execution with audit log
    console.log(`[Branch-A] Final charge amount: ${finalAmount}`);
    const success = await this.executeGateway(req.orderId, finalAmount);
    return success;
  }

  private async executeGateway(orderId: string, amount: number): Promise<boolean> {
    return amount > 0;
  }
}
