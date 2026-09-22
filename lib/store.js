const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const PALETTE = [
  "#ff7a18",
  "#3dc2ff",
  "#c8f542",
  "#ff4d6d",
  "#a78bfa",
  "#ffe566",
  "#5dffc2",
  "#ff9f43",
  "#f472b6",
  "#38bdf8",
];

function hasSupabase() {
  return Boolean(
    process.env.SUPABASE_URL &&
      (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)
  );
}

function normalizeFlagTargets(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((id) => String(id || "").trim()).filter(Boolean))];
}

function toCar(row) {
  if (!row) return null;
  const rawLast = row.last && typeof row.last === "object" ? { ...row.last } : null;
  const reconnectRequested =
    Number(row.reconnect_requested) || Number(rawLast?._reconnect) || null;
  if (rawLast) delete rawLast._reconnect;
  const last =
    rawLast && typeof rawLast.lat === "number" && typeof rawLast.lon === "number"
      ? rawLast
      : null;
  return {
    id: row.id,
    token: row.token,
    carNumber: row.car_number,
    driverName: row.driver_name,
    color: row.color,
    tracking: Boolean(row.tracking),
    last,
    trail: Array.isArray(row.trail) ? row.trail : [],
    section: row.section || null,
    crewStatus: row.crew_status || null,
    flagAck: row.flag_ack || null,
    reconnectRequested: reconnectRequested || null,
  };
}

function lastForRow(car) {
  const last = car.last && typeof car.last === "object" ? { ...car.last } : {};
  if (car.reconnectRequested) last._reconnect = Number(car.reconnectRequested);
  else delete last._reconnect;
  if (last.lat == null && last.lon == null && last._reconnect == null) return car.last || null;
  return last;
}

function toRow(car) {
  return {
    id: car.id,
    token: car.token,
    car_number: car.carNumber,
    driver_name: car.driverName,
    color: car.color,
    tracking: Boolean(car.tracking),
    last: lastForRow(car),
    trail: Array.isArray(car.trail) ? car.trail : [],
    section: car.section || null,
    crew_status: car.crewStatus || null,
    flag_ack: car.flagAck || null,
    updated_at: new Date().toISOString(),
  };
}

function missingRallyIdColumn(error) {
  const msg = String(error?.message || error || "");
  return /rally_id/i.test(msg);
}

function rallyRouteSchemaError(error) {
  if (missingRallyIdColumn(error)) {
    return new Error(
      "Run supabase/schema_rallies.sql so each rally can have its own KMZ (adds rally_id to rally_sections)."
    );
  }
  const msg = String(error?.message || error || "");
  if (/geometry_type|type.*check|check constraint/i.test(msg)) {
    return new Error(
      "Run supabase/schema_routes.sql so KMZ point placemarks can be stored (Point / marker)."
    );
  }
  return error;
}

function toSection(row) {
  if (!row) return null;
  const coordinates = Array.isArray(row.coordinates) ? row.coordinates : [];
  const firstPoint = coordinates[0] || null;
  return {
    id: row.id,
    name: row.name,
    type:
      row.type === "stage" || row.type === "road" || row.type === "marker"
        ? row.type
        : row.geometry_type === "Point"
          ? "marker"
          : "road",
    label: row.label,
    geometryType: row.geometry_type,
    coordinates,
    sourceFile: row.source_file || null,
    sortOrder: row.sort_order || 0,
    active: row.active !== false,
    flagStatus: row.flag_status === "red" ? "red" : "green",
    flagTs: Number(row.flag_ts) || 0,
    flagTargets: normalizeFlagTargets(row.flag_targets),
    rallyId: row.rally_id || null,
    iconKind: firstPoint?.iconKind || null,
    iconHref: firstPoint?.iconHref || null,
  };
}

function toSectionRow(section) {
  return {
    id: section.id,
    name: section.name,
    type: section.type,
    label: section.label,
    geometry_type: section.geometryType,
    coordinates: section.coordinates,
    source_file: section.sourceFile || null,
    sort_order: section.sortOrder || 0,
    active: section.active !== false,
    flag_status: section.flagStatus === "red" ? "red" : "green",
    flag_ts: Number(section.flagTs) || 0,
    flag_targets: normalizeFlagTargets(section.flagTargets),
    rally_id: section.rallyId || null,
  };
}

function toRally(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    startDate: row.start_date || null,
    endDate: row.end_date || null,
    status: row.status === "live" || row.status === "ended" ? row.status : "draft",
    snapshot: Array.isArray(row.snapshot)
      ? row.snapshot
      : Object.prototype.hasOwnProperty.call(row, "snapshot")
        ? null
        : undefined,
    pinIcons:
      row.pin_icons && typeof row.pin_icons === "object" && !Array.isArray(row.pin_icons)
        ? row.pin_icons
        : Object.prototype.hasOwnProperty.call(row, "pin_icons")
          ? {}
          : undefined,
    carCount: Number(row.car_count) || (Array.isArray(row.snapshot) ? row.snapshot.length : 0),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function toRallyRow(rally) {
  const row = {
    id: rally.id,
    name: rally.name,
    start_date: rally.startDate || null,
    end_date: rally.endDate || null,
    status: rally.status,
    car_count: Number(rally.carCount) || 0,
    updated_at: new Date().toISOString(),
  };
  if (rally.snapshot !== undefined) row.snapshot = rally.snapshot;
  if (rally.pinIcons !== undefined) row.pin_icons = rally.pinIcons || {};
  return row;
}

function rallySummary(rally) {
  if (!rally) return null;
  const { snapshot, pinIcons, ...rest } = rally;
  const icons = pinIcons && typeof pinIcons === "object" ? pinIcons : {};
  const pinIconSlots = {
    tc: Boolean(icons.tc?.data),
    start: Boolean(icons.start?.data),
    finish: Boolean(icons.finish?.data),
    stop: Boolean(icons.stop?.data),
    refuel: Boolean(icons.refuel?.data),
  };
  return { ...rest, pinIconSlots };
}

function createMemoryStore() {
  /** @type {Map<string, object>} */
  const cars = new Map();
  /** @type {Map<string, object>} */
  const sections = new Map();

  /** @type {Map<string, object>} */
  const rallies = new Map();
  let controlUser = null;

  return {
    mode: "memory",
    async listCars() {
      return [...cars.values()];
    },
    async getCar(id) {
      return cars.get(id) || null;
    },
    async findByCarNumber(carNumber) {
      const key = carNumber.toLowerCase();
      for (const car of cars.values()) {
        if (car.carNumber.toLowerCase() === key) return car;
      }
      return null;
    },
    async saveCar(car) {
      cars.set(car.id, car);
      return car;
    },
    async clearCars() {
      const count = cars.size;
      cars.clear();
      return count;
    },
    async nextColorIndex() {
      return cars.size;
    },
    async listRallies() {
      return [...rallies.values()].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    },
    async getRally(id) {
      return rallies.get(id) || null;
    },
    async getLiveRally() {
      return [...rallies.values()].find((r) => r.status === "live") || null;
    },
    async saveRally(rally) {
      rallies.set(rally.id, rally);
      return rally;
    },
    async deleteRally(id) {
      for (const [sectionId, section] of [...sections]) {
        if (section.rallyId === id) sections.delete(sectionId);
      }
      return rallies.delete(id);
    },
    async getControlUser(username) {
      return controlUser && controlUser.username === username ? controlUser : null;
    },
    async saveControlUser(user) {
      controlUser = user;
      return user;
    },
    async listSections(rallyId) {
      let list = [...sections.values()];
      if (rallyId) list = list.filter((section) => section.rallyId === rallyId);
      return list
        .map((section) => ({
          ...section,
          flagTargets: normalizeFlagTargets(section.flagTargets),
        }))
        .sort((a, b) => a.sortOrder - b.sortOrder);
    },
    async getSection(id) {
      const section = sections.get(id) || null;
      if (!section) return null;
      return {
        ...section,
        flagTargets: normalizeFlagTargets(section.flagTargets),
      };
    },
    async replaceSections(list, rallyId) {
      if (!rallyId) throw new Error("Select a rally first, then upload its KMZ.");
      for (const [id, section] of [...sections]) {
        if (section.rallyId === rallyId) sections.delete(id);
      }
      for (const section of list) {
        sections.set(section.id, { ...section, rallyId });
      }
      return [...sections.values()]
        .filter((section) => section.rallyId === rallyId)
        .sort((a, b) => a.sortOrder - b.sortOrder);
    },
    async clearSections(rallyId) {
      if (!rallyId) throw new Error("Select a rally first, then clear its KMZ.");
      for (const [id, section] of [...sections]) {
        if (section.rallyId === rallyId) sections.delete(id);
      }
    },
    async updateSection(id, patch) {
      const current = sections.get(id);
      if (!current) return null;
      const next = { ...current, ...patch, id, rallyId: current.rallyId };
      if (Object.prototype.hasOwnProperty.call(patch, "flagTargets")) {
        next.flagTargets = normalizeFlagTargets(patch.flagTargets);
      } else if (!Array.isArray(next.flagTargets)) {
        next.flagTargets = [];
      }
      sections.set(id, next);
      return next;
    },
    async deleteSection(id) {
      return sections.delete(id);
    },
  };
}

function createSupabaseStore() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return {
    mode: "supabase",
    async listCars() {
      const { data, error } = await supabase.from("rally_cars").select("*");
      if (error) throw error;
      return (data || []).map(toCar);
    },
    async getCar(id) {
      const { data, error } = await supabase
        .from("rally_cars")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      return toCar(data);
    },
    async findByCarNumber(carNumber) {
      const { data, error } = await supabase
        .from("rally_cars")
        .select("*")
        .ilike("car_number", carNumber)
        .maybeSingle();
      if (error) throw error;
      return toCar(data);
    },
    async saveCar(car) {
      const { error } = await supabase.from("rally_cars").upsert(toRow(car), {
        onConflict: "id",
      });
      if (error) throw error;
      return car;
    },
    async clearCars() {
      const { data, error: countError } = await supabase.from("rally_cars").select("id");
      if (countError) throw countError;
      const count = (data || []).length;
      const { error } = await supabase
        .from("rally_cars")
        .delete()
        .neq("id", "00000000-0000-0000-0000-000000000000");
      if (error) throw error;
      return count;
    },
    async nextColorIndex() {
      const { count, error } = await supabase
        .from("rally_cars")
        .select("*", { count: "exact", head: true });
      if (error) throw error;
      return count || 0;
    },
    async listSections(rallyId) {
      let query = supabase.from("rally_sections").select("*").order("sort_order", { ascending: true });
      if (rallyId) query = query.eq("rally_id", rallyId);
      const { data, error } = await query;
      if (error) throw rallyRouteSchemaError(error);
      return (data || []).map(toSection);
    },
    async getSection(id) {
      const { data, error } = await supabase
        .from("rally_sections")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      return toSection(data);
    },
    async replaceSections(list, rallyId) {
      if (!rallyId) throw new Error("Select a rally first, then upload its KMZ.");
      const { error: delError } = await supabase.from("rally_sections").delete().eq("rally_id", rallyId);
      if (delError) throw rallyRouteSchemaError(delError);
      if (!list.length) return [];
      const { data, error } = await supabase
        .from("rally_sections")
        .insert(list.map((section) => toSectionRow({ ...section, rallyId })))
        .select("*");
      if (error) throw rallyRouteSchemaError(error);
      return (data || []).map(toSection);
    },
    async clearSections(rallyId) {
      if (!rallyId) throw new Error("Select a rally first, then clear its KMZ.");
      const { error } = await supabase.from("rally_sections").delete().eq("rally_id", rallyId);
      if (error) throw rallyRouteSchemaError(error);
    },
    async updateSection(id, patch) {
      const rowPatch = {};
      if (patch.name != null) rowPatch.name = patch.name;
      if (patch.type != null) rowPatch.type = patch.type;
      if (patch.label != null) rowPatch.label = patch.label;
      if (patch.active != null) rowPatch.active = patch.active;
      if (patch.sortOrder != null) rowPatch.sort_order = patch.sortOrder;
      if (patch.flagStatus != null) rowPatch.flag_status = patch.flagStatus;
      if (patch.flagTs != null) rowPatch.flag_ts = patch.flagTs;
      if (Object.prototype.hasOwnProperty.call(patch, "flagTargets")) {
        rowPatch.flag_targets = normalizeFlagTargets(patch.flagTargets);
      }
      const { data, error } = await supabase
        .from("rally_sections")
        .update(rowPatch)
        .eq("id", id)
        .select("*")
        .maybeSingle();
      if (error) {
        if (rowPatch.flag_targets !== undefined && /flag_targets/i.test(error.message || "")) {
          throw new Error(
            "Run supabase/schema_routes.sql so selective red-flag targets can be stored (adds flag_targets)."
          );
        }
        throw error;
      }
      return toSection(data);
    },
    async deleteSection(id) {
      const { error } = await supabase.from("rally_sections").delete().eq("id", id);
      if (error) throw error;
      return true;
    },
    async listRallies() {
      const { data, error } = await supabase
        .from("rally_events")
        .select("id,name,start_date,end_date,status,car_count,created_at,updated_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data || []).map(toRally);
    },
    async getRally(id) {
      const { data, error } = await supabase
        .from("rally_events")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      return toRally(data);
    },
    async getLiveRally() {
      const { data, error } = await supabase
        .from("rally_events")
        .select("id,name,start_date,end_date,status,car_count,created_at,updated_at")
        .eq("status", "live")
        .maybeSingle();
      if (error) throw error;
      return toRally(data);
    },
    async saveRally(rally) {
      const row = toRallyRow(rally);
      if (!rally.createdAt) row.created_at = new Date().toISOString();
      const { error } = await supabase.from("rally_events").upsert(row, { onConflict: "id" });
      if (error && /pin_icons/i.test(error.message || "") && row.pin_icons !== undefined) {
        delete row.pin_icons;
        const retry = await supabase.from("rally_events").upsert(row, { onConflict: "id" });
        if (retry.error) throw retry.error;
        if (rally.pinIcons && Object.keys(rally.pinIcons).length) {
          throw new Error(
            "Run supabase/schema_rallies.sql so TC/Start/Finish/Stop/Refueling images can be stored (adds pin_icons)."
          );
        }
        return rally;
      }
      if (error) throw error;
      return rally;
    },
    async deleteRally(id) {
      const { error: sectionError } = await supabase.from("rally_sections").delete().eq("rally_id", id);
      if (sectionError && !missingRallyIdColumn(sectionError)) throw sectionError;
      const { error } = await supabase.from("rally_events").delete().eq("id", id);
      if (error) throw error;
      return true;
    },
    async getControlUser(username) {
      const { data, error } = await supabase
        .from("rally_control_users")
        .select("*")
        .eq("username", username)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return {
        username: data.username,
        salt: data.password_salt,
        hash: data.password_hash,
        mustChangePassword: data.must_change !== false,
      };
    },
    async saveControlUser(user) {
      const { error } = await supabase.from("rally_control_users").upsert(
        {
          username: user.username,
          password_salt: user.salt,
          password_hash: user.hash,
          must_change: Boolean(user.mustChangePassword),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "username" }
      );
      if (error) throw error;
      return user;
    },
  };
}

function getStore() {
  if (hasSupabase()) return createSupabaseStore();
  return createMemoryStore();
}

function pickColor(index) {
  return PALETTE[index % PALETTE.length];
}

function newToken() {
  return crypto.randomBytes(16).toString("hex");
}

module.exports = {
  PALETTE,
  getStore,
  hasSupabase,
  hasUpstash: hasSupabase,
  pickColor,
  newToken,
  toRally,
  rallySummary,
  normalizeFlagTargets,
};
