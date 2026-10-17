export type DiscountKind = "fixed" | "percentage";
export type AdvanceKind = "fixed" | "percentage";
export type BookingStatus =
  | "pending_payment"
  | "confirmed"
  | "cancelled"
  | "completed"
  | "no_show"
  | "payment_failed"
  | "expired";

export interface QuoteCoupon {
  discount_type: DiscountKind;
  discount_value: number;
  minimum_spend_paise: number;
  max_discount_paise: number | null;
  is_active: boolean;
  starts_at: string | null;
  ends_at: string | null;
}

export interface QuoteInput {
  servicePricePaise: number;
  addonPricesPaise: number[];
  taxRateBasisPoints: number;
  advanceType: AdvanceKind;
  advanceValue: number;
  coupon?: QuoteCoupon | null;
  now?: Date;
}

export interface Quote {
  subtotalPaise: number;
  discountPaise: number;
  taxPaise: number;
  totalPaise: number;
  advanceDuePaise: number;
  balanceDuePaise: number;
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function applyBasisPoints(amountPaise: number, basisPoints: number): number {
  const result = (BigInt(amountPaise) * BigInt(basisPoints)) / 10_000n;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Calculated amount exceeds the safe amount");
  return Number(result);
}

export function calculateQuote(input: QuoteInput): Quote {
  assertNonNegativeInteger(input.servicePricePaise, "Service price");
  assertNonNegativeInteger(input.taxRateBasisPoints, "Tax rate");
  if (input.taxRateBasisPoints > 10_000) throw new RangeError("Tax rate cannot exceed 100%");
  assertNonNegativeInteger(input.advanceValue, "Advance value");
  for (const price of input.addonPricesPaise) assertNonNegativeInteger(price, "Add-on price");

  if (input.advanceType === "percentage" && input.advanceValue > 10_000) {
    throw new RangeError("Advance percentage cannot exceed 100%");
  }

  const subtotalPaise = input.addonPricesPaise.reduce(
    (sum, price) => sum + price,
    input.servicePricePaise,
  );
  if (!Number.isSafeInteger(subtotalPaise)) throw new RangeError("Subtotal exceeds the safe amount");

  let discountPaise = 0;
  const coupon = input.coupon;
  if (coupon?.is_active) {
    const now = input.now ?? new Date();
    const starts = coupon.starts_at ? Date.parse(coupon.starts_at) : Number.NEGATIVE_INFINITY;
    const ends = coupon.ends_at ? Date.parse(coupon.ends_at) : Number.POSITIVE_INFINITY;
    if (now.getTime() >= starts && now.getTime() < ends && subtotalPaise >= coupon.minimum_spend_paise) {
      assertNonNegativeInteger(coupon.discount_value, "Coupon discount");
      if (coupon.discount_type === "percentage") {
        if (coupon.discount_value > 10_000) {
          throw new RangeError("Coupon percentage must be between 0% and 100%");
        }
        discountPaise = applyBasisPoints(subtotalPaise, coupon.discount_value);
        if (coupon.max_discount_paise !== null) {
          assertNonNegativeInteger(coupon.max_discount_paise, "Maximum discount");
          discountPaise = Math.min(discountPaise, coupon.max_discount_paise);
        }
      } else {
        assertNonNegativeInteger(coupon.discount_value, "Coupon discount");
        discountPaise = coupon.discount_value;
      }
      discountPaise = Math.min(discountPaise, subtotalPaise);
    }
  }

  const discountedSubtotal = subtotalPaise - discountPaise;
  const taxPaise = applyBasisPoints(discountedSubtotal, input.taxRateBasisPoints);
  const totalPaise = discountedSubtotal + taxPaise;
  const advanceDuePaise =
    input.advanceType === "percentage"
      ? applyBasisPoints(totalPaise, input.advanceValue)
      : Math.min(input.advanceValue, totalPaise);

  if (![taxPaise, totalPaise, advanceDuePaise].every(Number.isSafeInteger)) {
    throw new RangeError("Calculated amount exceeds the safe amount");
  }
  return {
    subtotalPaise,
    discountPaise,
    taxPaise,
    totalPaise,
    advanceDuePaise,
    balanceDuePaise: totalPaise - advanceDuePaise,
  };
}

const allowedTransitions: Record<BookingStatus, readonly BookingStatus[]> = {
  pending_payment: ["confirmed", "payment_failed", "expired", "cancelled"],
  confirmed: ["cancelled", "completed", "no_show"],
  cancelled: [],
  completed: [],
  no_show: [],
  payment_failed: ["pending_payment", "confirmed", "expired", "cancelled"],
  expired: [],
};

export function canTransitionBooking(from: BookingStatus, to: BookingStatus): boolean {
  return allowedTransitions[from].includes(to);
}

export function assertBookingTransition(from: BookingStatus, to: BookingStatus): void {
  if (!canTransitionBooking(from, to)) {
    throw new Error(`Booking cannot transition from ${from} to ${to}`);
  }
}
