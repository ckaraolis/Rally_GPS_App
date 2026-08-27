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
    updated_at: new Date().toISOString(),
  };
}

function createMemoryStore() {
  /** @type {Map<string, object>} */
  const cars = new Map();

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
  hasUpstash: hasSupabase, // backwards-compatible alias for older health checks
  pickColor,
  newToken,
};
