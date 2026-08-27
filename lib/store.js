const crypto = require("crypto");
const { Redis } = require("@upstash/redis");

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

const CARS_KEY = "rally:cars";
const COUNT_KEY = "rally:carCount";

function hasUpstash() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
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

function createRedisStore() {
  const redis = Redis.fromEnv();

  async function readAll() {
    const raw = await redis.hgetall(CARS_KEY);
    if (!raw || typeof raw !== "object") return [];
    return Object.values(raw).map((value) => {
      if (typeof value === "string") {
        try {
          return JSON.parse(value);
        } catch {
          return null;
        }
      }
      return value;
    }).filter(Boolean);
  }

  return {
    mode: "redis",
    async listCars() {
      return readAll();
    },
    async getCar(id) {
      const value = await redis.hget(CARS_KEY, id);
      if (!value) return null;
      if (typeof value === "string") {
        try {
          return JSON.parse(value);
        } catch {
          return null;
        }
      }
      return value;
    },
    async findByCarNumber(carNumber) {
      const key = carNumber.toLowerCase();
      const list = await readAll();
      return list.find((car) => String(car.carNumber).toLowerCase() === key) || null;
    },
    async saveCar(car) {
      await redis.hset(CARS_KEY, { [car.id]: JSON.stringify(car) });
      return car;
    },
    async nextColorIndex() {
      const count = await redis.incr(COUNT_KEY);
      return Math.max(0, count - 1);
    },
  };
}

function getStore() {
  if (hasUpstash()) return createRedisStore();
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
  hasUpstash,
  pickColor,
  newToken,
};
