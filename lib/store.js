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

function toCar(row) {
  if (!row) return null;
  return {
    id: row.id,
    token: row.token,
    carNumber: row.car_number,
    driverName: row.driver_name,
    color: row.color,
    tracking: Boolean(row.tracking),
    last: row.last || null,
    trail: Array.isArray(row.trail) ? row.trail : [],
    section: row.section || null,
    crewStatus: row.crew_status || null,
  };
}

function toRow(car) {
  return {
    id: car.id,
    token: car.token,
    car_number: car.carNumber,
    driver_name: car.driverName,
    color: car.color,
    tracking: Boolean(car.tracking),
    last: car.last || null,
    trail: Array.isArray(car.trail) ? car.trail : [],
    section: car.section || null,
    crew_status: car.crewStatus || null,
    updated_at: new Date().toISOString(),
  };
}

function toSection(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    label: row.label,
    geometryType: row.geometry_type,
    coordinates: Array.isArray(row.coordinates) ? row.coordinates : [],
    sourceFile: row.source_file || null,
    sortOrder: row.sort_order || 0,
    active: row.active !== false,
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
  };
}

function createMemoryStore() {
  /** @type {Map<string, object>} */
  const cars = new Map();
  /** @type {Map<string, object>} */
  const sections = new Map();

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
    async nextColorIndex() {
      return cars.size;
    },
    async listSections() {
      return [...sections.values()].sort((a, b) => a.sortOrder - b.sortOrder);
    },
    async replaceSections(list) {
      sections.clear();
      for (const section of list) sections.set(section.id, section);
      return [...sections.values()];
    },
    async clearSections() {
      sections.clear();
    },
    async updateSection(id, patch) {
      const current = sections.get(id);
      if (!current) return null;
      const next = { ...current, ...patch, id };
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
    async nextColorIndex() {
      const { count, error } = await supabase
        .from("rally_cars")
        .select("*", { count: "exact", head: true });
      if (error) throw error;
      return count || 0;
    },
    async listSections() {
      const { data, error } = await supabase
        .from("rally_sections")
        .select("*")
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return (data || []).map(toSection);
    },
    async replaceSections(list) {
      const { error: delError } = await supabase
        .from("rally_sections")
        .delete()
        .neq("id", "00000000-0000-0000-0000-000000000000");
      if (delError) throw delError;
      if (!list.length) return [];
      const { data, error } = await supabase
        .from("rally_sections")
        .insert(list.map(toSectionRow))
        .select("*");
      if (error) throw error;
      return (data || []).map(toSection);
    },
    async clearSections() {
      const { error } = await supabase
        .from("rally_sections")
        .delete()
        .neq("id", "00000000-0000-0000-0000-000000000000");
      if (error) throw error;
    },
    async updateSection(id, patch) {
      const rowPatch = {};
      if (patch.name != null) rowPatch.name = patch.name;
      if (patch.type != null) rowPatch.type = patch.type;
      if (patch.label != null) rowPatch.label = patch.label;
      if (patch.active != null) rowPatch.active = patch.active;
      if (patch.sortOrder != null) rowPatch.sort_order = patch.sortOrder;
      const { data, error } = await supabase
        .from("rally_sections")
        .update(rowPatch)
        .eq("id", id)
        .select("*")
        .maybeSingle();
      if (error) throw error;
      return toSection(data);
    },
    async deleteSection(id) {
      const { error } = await supabase.from("rally_sections").delete().eq("id", id);
      if (error) throw error;
      return true;
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
};
