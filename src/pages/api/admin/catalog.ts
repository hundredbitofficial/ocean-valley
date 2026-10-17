import type { APIRoute } from "astro";
import { z } from "zod";
import { createRequestSupabase, isAdminRole } from "@/lib/server/supabase";

const optionalText = z.string().trim().max(5000).nullable().optional();
const serviceFields = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120).optional(),
  short_description: optionalText,
  description: optionalText,
  duration_minutes: z.coerce.number().int().min(1).max(1440).optional(),
  buffer_minutes: z.coerce.number().int().min(0).max(1440).optional(),
  price_paise: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  advance_type: z.enum(["fixed", "percentage"]).optional(),
  advance_value: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  tax_rate_basis_points: z.coerce.number().int().min(0).max(10000).optional(),
  category_id: z.string().uuid().nullable().optional(),
  is_active: z.boolean().optional(),
  is_featured: z.boolean().optional(),
  sort_order: z.coerce.number().int().min(0).max(100000).optional(),
}).strict();
const categoryFields = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120).optional(),
  description: optionalText,
  sort_order: z.coerce.number().int().min(0).max(100000).optional(),
  is_active: z.boolean().optional(),
}).strict();
const addonFields = z.object({
  service_id: z.string().uuid().optional(),
  name: z.string().trim().min(2).max(120).optional(),
  description: optionalText,
  price_paise: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  extra_duration_minutes: z.coerce.number().int().min(0).max(1440).optional(),
  is_active: z.boolean().optional(),
  sort_order: z.coerce.number().int().min(0).max(100000).optional(),
}).strict();
const chamberFields = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  chamber_type: z.string().trim().min(2).max(80).optional(),
  capacity: z.coerce.number().int().min(1).max(100).optional(),
  is_active: z.boolean().optional(),
  sort_order: z.coerce.number().int().min(0).max(100000).optional(),
}).strict();
const availabilityFields = z.object({
  weekday: z.coerce.number().int().min(0).max(6).optional(),
  opens_at: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  closes_at: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  slot_interval_minutes: z.coerce.number().int().min(1).max(1440).optional(),
  capacity: z.coerce.number().int().min(1).max(1000).optional(),
  is_closed: z.boolean().optional(),
  service_id: z.string().uuid().nullable().optional(),
}).strict();
const exceptionFields = z.object({
  starts_at: z.string().datetime().optional(),
  ends_at: z.string().datetime().optional(),
  exception_type: z.enum(["closed", "capacity_override"]).optional(),
  capacity_override: z.coerce.number().int().min(0).max(1000).nullable().optional(),
  reason: z.string().trim().max(500).nullable().optional(),
}).strict();
const offerFields = z.object({
  code: z.string().trim().min(2).max(60).regex(/^[A-Za-z0-9_-]+$/).optional(),
  description: optionalText,
  discount_type: z.enum(["fixed", "percentage"]).optional(),
  discount_value: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  max_discount_paise: z.coerce.number().int().min(0).nullable().optional(),
  minimum_spend_paise: z.coerce.number().int().min(0).optional(),
  starts_at: z.string().datetime().nullable().optional(),
  ends_at: z.string().datetime().nullable().optional(),
  max_redemptions: z.coerce.number().int().min(1).nullable().optional(),
  max_per_customer: z.coerce.number().int().min(1).nullable().optional(),
  first_booking_only: z.boolean().optional(),
  is_active: z.boolean().optional(),
}).strict();

const requestSchema = z.object({
  entity: z.enum(["services", "categories", "add-ons", "chambers", "availability", "exceptions", "offers", "settings"]),
  operation: z.enum(["save", "delete"]).default("save"),
  recordId: z.string().uuid().optional(),
  values: z.record(z.string(), z.unknown()),
}).strict();

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

function generatedSlug(name: string, fallback: string): string {
  const slug = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 110).replace(/-$/g, "");
  return slug || `${fallback}-${crypto.randomUUID().slice(0, 8)}`;
}

export const POST: APIRoute = async ({ request, cookies }) => {
  const client = createRequestSupabase(cookies, request);
  if (!client) return jsonError("Admin data management is not configured.", 503);
  const { data: { user }, error: authError } = await client.auth.getUser();
  if (authError || !user || !isAdminRole(user.app_metadata)) return jsonError("Administrator access is required.", 403);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Provide a valid JSON request.", 400);
  }
  const parsedRequest = requestSchema.safeParse(body);
  if (!parsedRequest.success) return jsonError("The record request is invalid.", 400);
  const { entity, operation, recordId, values } = parsedRequest.data;
  if (operation === "delete") {
    if (entity !== "exceptions" || !recordId) return jsonError("Only a specific availability exception can be removed.", 400);
    const { data: removed, error: deleteError } = await client.from("availability_exceptions").delete().eq("id", recordId).select("id").maybeSingle();
    if (deleteError) {
      console.error(`Admin availability exception removal failed: ${deleteError.code ?? "database_error"}`);
      return jsonError("The availability exception could not be removed.", 400);
    }
    if (!removed) return jsonError("That availability exception no longer exists.", 404);
    return Response.json({ id: removed.id, deleted: true });
  }
  if (entity === "settings") {
    if (recordId) return jsonError("Settings are identified by key, not record id.", 400);
    const setting = z.object({
      key: z.enum(["booking_horizon_days", "minimum_lead_time_minutes", "booking_hold_minutes"]),
      value: z.coerce.number().int(),
    }).strict().safeParse(values);
    if (!setting.success) return jsonError("Choose a supported booking setting and a whole-number value.", 400);
    const limits = {
      booking_horizon_days: { min: 1, max: 365, property: "days" },
      minimum_lead_time_minutes: { min: 0, max: 10080, property: "minutes" },
      booking_hold_minutes: { min: 5, max: 60, property: "minutes" },
    } as const;
    const rule = limits[setting.data.key];
    if (setting.data.value < rule.min || setting.data.value > rule.max) {
      return jsonError(`Value must be between ${rule.min} and ${rule.max}.`, 400);
    }
    const { error } = await client.from("business_settings").upsert({
      key: setting.data.key,
      value: { [rule.property]: setting.data.value },
      is_public: false,
      updated_by: user.id,
    }, { onConflict: "key" });
    if (error) {
      console.error(`Admin booking setting save failed: ${error.code ?? "database_error"}`);
      return jsonError("The booking setting could not be saved.", 400);
    }
    return Response.json({ key: setting.data.key, updated: true });
  }
  if (recordId && !Object.keys(values).length) return jsonError("Provide at least one value to update.", 400);

  let parsedValues:
    | z.infer<typeof serviceFields>
    | z.infer<typeof categoryFields>
    | z.infer<typeof addonFields>
    | z.infer<typeof chamberFields>
    | z.infer<typeof availabilityFields>
    | z.infer<typeof exceptionFields>
    | z.infer<typeof offerFields>;
  switch (entity) {
    case "services": {
      const parsed = serviceFields.safeParse(values);
      if (!parsed.success) return jsonError("Check the service fields and try again.", 400);
      if (!recordId && (!parsed.data.name || parsed.data.duration_minutes === undefined || parsed.data.price_paise === undefined)) {
        return jsonError("A service needs a name, duration and price.", 400);
      }
      if (parsed.data.advance_type === "percentage" && parsed.data.advance_value !== undefined && parsed.data.advance_value > 10000) {
        return jsonError("A percentage advance cannot exceed 100%.", 400);
      }
      parsedValues = !recordId && parsed.data.name
        ? { ...parsed.data, slug: parsed.data.slug ?? generatedSlug(parsed.data.name, "treatment") }
        : parsed.data;
      break;
    }
    case "categories": {
      const parsed = categoryFields.safeParse(values);
      if (!parsed.success) return jsonError("Check the category fields and try again.", 400);
      if (!recordId && !parsed.data.name) return jsonError("A category needs a name.", 400);
      parsedValues = !recordId && parsed.data.name
        ? { ...parsed.data, slug: parsed.data.slug ?? generatedSlug(parsed.data.name, "category") }
        : parsed.data;
      break;
    }
    case "add-ons": {
      const parsed = addonFields.safeParse(values);
      if (!parsed.success) return jsonError("Check the add-on fields and try again.", 400);
      if (!recordId && (!parsed.data.service_id || !parsed.data.name || parsed.data.price_paise === undefined)) {
        return jsonError("An add-on needs a service, name and price.", 400);
      }
      parsedValues = parsed.data;
      break;
    }
    case "chambers": {
      const parsed = chamberFields.safeParse(values);
      if (!parsed.success) return jsonError("Check the treatment chamber fields and try again.", 400);
      if (!recordId && !parsed.data.name) return jsonError("A treatment chamber needs a name.", 400);
      parsedValues = parsed.data;
      break;
    }
    case "availability": {
      const parsed = availabilityFields.safeParse(values);
      if (!parsed.success) return jsonError("Check the availability fields and try again.", 400);
      if (!recordId && (parsed.data.weekday === undefined || !parsed.data.opens_at || !parsed.data.closes_at || parsed.data.slot_interval_minutes === undefined || parsed.data.capacity === undefined)) {
        return jsonError("Availability needs a weekday, opening and closing time, interval and capacity.", 400);
      }
      if (parsed.data.opens_at && parsed.data.closes_at && parsed.data.closes_at <= parsed.data.opens_at) {
        return jsonError("Closing time must be later than opening time.", 400);
      }
      parsedValues = parsed.data;
      break;
    }
    case "exceptions": {
      const parsed = exceptionFields.safeParse(values);
      if (!parsed.success) return jsonError("Check the availability exception fields and try again.", 400);
      if (!recordId && (!parsed.data.starts_at || !parsed.data.ends_at || !parsed.data.exception_type)) {
        return jsonError("An exception needs a start, end and exception type.", 400);
      }
      if (parsed.data.starts_at && parsed.data.ends_at && parsed.data.ends_at <= parsed.data.starts_at) {
        return jsonError("An exception must end after it starts.", 400);
      }
      if (parsed.data.exception_type === "capacity_override" && parsed.data.capacity_override === undefined) {
        return jsonError("This exception type requires a capacity override.", 400);
      }
      parsedValues = parsed.data;
      break;
    }
    case "offers": {
      const parsed = offerFields.safeParse(values);
      if (!parsed.success) return jsonError("Check the offer fields and try again.", 400);
      if (!recordId && (!parsed.data.code || !parsed.data.discount_type || parsed.data.discount_value === undefined)) {
        return jsonError("An offer needs a code, discount type and discount value.", 400);
      }
      if (parsed.data.discount_type === "percentage" && parsed.data.discount_value !== undefined && parsed.data.discount_value > 10000) {
        return jsonError("A percentage discount cannot exceed 100%.", 400);
      }
      if (parsed.data.starts_at && parsed.data.ends_at && parsed.data.ends_at <= parsed.data.starts_at) {
        return jsonError("An offer must end after it starts.", 400);
      }
      parsedValues = { ...parsed.data, code: parsed.data.code?.toUpperCase() };
      break;
    }
  }

  const tableByEntity = {
    services: "services",
    categories: "service_categories",
    "add-ons": "service_addons",
    chambers: "treatment_chambers",
    availability: "availability_rules",
    exceptions: "availability_exceptions",
    offers: "coupons",
  } as const;
  const table = tableByEntity[entity];
  const { data: saved, error } = recordId
    ? await client.from(table).update(parsedValues).eq("id", recordId).select("id").maybeSingle()
    : await client.from(table).insert(parsedValues).select("id").single();
  if (error) {
    console.error(`Admin ${entity} save failed: ${error.code ?? "database_error"}`);
    const conflictMessage = entity === "availability"
      ? "An availability rule already exists for that weekday and service."
      : "That URL slug or offer code already exists.";
    return jsonError(error.code === "23505" ? conflictMessage : "The record could not be saved. Check its values and try again.", 400);
  }
  if (!saved) return jsonError("That record no longer exists.", 404);
  return Response.json({ id: saved.id, updated: Boolean(recordId) });
};
