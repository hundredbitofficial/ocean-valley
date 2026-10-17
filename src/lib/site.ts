export const brand = {
  name: "Ocean Valley",
  timezone: "Asia/Kolkata",
  description: "A quieter space to return to yourself.",
};

export function formatRupees(paise: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(paise / 100);
}
