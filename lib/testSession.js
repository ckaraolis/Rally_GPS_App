/**
 * Isolated in-memory sandbox for Test mode.
 * Never reads or writes rally_cars, rally_sections, or liveSections().
 */
const TEST_STAGE_ID = "test-stage";
const TEST_ROAD_ID = "test-road";
const MOVING_SPEED_MPS = 22.2;

function defaultDemoCars() {
  return [
    {
      id: "test-car-1",
      carNumber: "1",
      driverName: "Ahead Crew",
      progressPct: 85,
      crewStatus: null,
      aheadOfSos: true,
    },
    {
      id: "test-car-2",
      carNumber: "2",
      driverName: "SOS Crew",
      progressPct: 45,
      crewStatus: "sos",
      aheadOfSos: false,
    },
    {
      id: "test-car-3",
      carNumber: "3",
      driverName: "Behind Crew",
      progressPct: 20,
      crewStatus: null,
      aheadOfSos: false,
    },
  ];
}

function normalizeTargets(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((id) => String(id || "").trim()).filter(Boolean))];
}

function defaultState() {
  return {
    mode: "road",
    stageName: "SS Test",
    roadName: "Liaison Test",
    flagStatus: "green",
    flagTs: 0,
    flagTargets: [],
    crewStatus: null,
    flagAck: null,
    motion: "moving",
    forceStoppedAlert: false,
    previewCarId: "test-car-2",
    cars: defaultDemoCars(),
    updatedAt: Date.now(),
  };
}

let state = defaultState();

function findCar(id) {
  return state.cars.find((c) => c.id === String(id));
}

function previewCar() {
  return findCar(state.previewCarId) || state.cars[0] || defaultDemoCars()[1];
}

function isPreviewTargeted() {
  if (state.flagStatus !== "red") return false;
  const targets = normalizeTargets(state.flagTargets);
  if (!targets.length) return false;
  return targets.includes(String(previewCar().id));
}

function sectionFor(current) {
  if (current.mode === "stage") {
    return {
      id: TEST_STAGE_ID,
      type: "stage",
      name: current.stageName,
      label: current.stageName,
      flagStatus: current.flagStatus === "red" ? "red" : "green",
      flagTs: Number(current.flagTs) || 0,
      flagTargets: normalizeTargets(current.flagTargets),
    };
  }
  return {
    id: TEST_ROAD_ID,
    type: "road",
    name: current.roadName,
    label: current.roadName,
  };
}

function serializeCars() {
  return state.cars.map((car) => ({
    id: car.id,
    carNumber: car.carNumber,
    driverName: car.driverName,
    progressPct: Number(car.progressPct) || 0,
    crewStatus: car.crewStatus || null,
    aheadOfSos: Boolean(car.aheadOfSos),
    onStage: state.mode === "stage",
  }));
}

function snapshot() {
  const section = sectionFor(state);
  const onStage = state.mode === "stage";
  const stageFlagStatus = onStage && state.flagStatus === "red" ? "red" : "green";
  const flagTs = Number(state.flagTs) || 0;
  const flagTargets = normalizeTargets(state.flagTargets);
  const preview = previewCar();
  const flagTargeted = isPreviewTargeted();
  const flagStatus = flagTargeted ? "red" : "green";
  const flagAcked =
    flagStatus !== "red" ||
    (state.flagAck != null && Number(state.flagAck.flagTs) === flagTs);
  const stopped = state.motion === "stopped";
  const previewCrew =
    state.crewStatus?.status ||
    (preview.crewStatus === "ok" || preview.crewStatus === "sos" ? preview.crewStatus : null);
  return {
    ok: true,
    test: true,
    tracking: true,
    carNumber: preview.carNumber,
    driverName: preview.driverName,
    previewCarId: preview.id,
    cars: serializeCars(),
    section,
    crewStatus:
      previewCrew === "ok" || previewCrew === "sos"
        ? {
            status: previewCrew,
            ts: state.crewStatus?.ts || Date.now(),
            stageId: TEST_STAGE_ID,
            stageName: state.stageName,
          }
        : null,
    stageFlagStatus,
    flagStatus,
    flagTs,
    flagTargets,
    flagTargeted,
    flagAcked,
    speed: stopped ? 0 : MOVING_SPEED_MPS,
    motion: stopped ? "stopped" : "moving",
    forceStoppedAlert: Boolean(onStage && state.forceStoppedAlert),
    updatedAt: state.updatedAt,
  };
}

function touch() {
  state.updatedAt = Date.now();
  return snapshot();
}

function reset() {
  state = defaultState();
  return snapshot();
}

function setCrewStatus(status) {
  const value = String(status || "").toLowerCase();
  if (value !== "ok" && value !== "sos") {
    throw Object.assign(new Error("status must be ok or sos."), { statusCode: 400 });
  }
  if (state.mode !== "stage") {
    state.mode = "stage";
    state.flagStatus = "green";
    state.flagTs = Date.now();
    state.flagTargets = [];
    state.flagAck = null;
  }
  state.crewStatus = {
    status: value,
    ts: Date.now(),
    stageId: TEST_STAGE_ID,
    stageName: state.stageName,
  };
  const preview = previewCar();
  if (preview) preview.crewStatus = value;
  state.forceStoppedAlert = false;
  return touch();
}

function ackFlag() {
  if (state.mode !== "stage" || state.flagStatus !== "red") {
    throw Object.assign(new Error("Test car is not on a red-flagged stage."), { statusCode: 400 });
  }
  if (!isPreviewTargeted()) {
    throw Object.assign(new Error("This preview car is not a red-flag target."), { statusCode: 400 });
  }
  state.flagAck = { stageId: TEST_STAGE_ID, flagTs: state.flagTs, ts: Date.now() };
  return touch();
}

function applyHqPatch(body) {
  if (!body || typeof body !== "object") {
    throw Object.assign(new Error("Invalid test controls."), { statusCode: 400 });
  }
  if (body.reset === true) return reset();

  if (body.stageName != null) {
    const name = String(body.stageName).trim().slice(0, 40);
    if (name) state.stageName = name;
  }
  if (body.roadName != null) {
    const name = String(body.roadName).trim().slice(0, 40);
    if (name) state.roadName = name;
  }

  if (body.previewCarId != null) {
    const next = findCar(body.previewCarId);
    if (!next) {
      throw Object.assign(new Error("Unknown preview car."), { statusCode: 400 });
    }
    state.previewCarId = next.id;
    state.flagAck = null;
  }

  if (body.mode === "road" || body.mode === "stage") {
    const prev = state.mode;
    state.mode = body.mode;
    if (prev !== body.mode) {
      state.crewStatus = null;
      state.forceStoppedAlert = false;
      if (body.mode === "road") {
        state.flagStatus = "green";
        state.flagTargets = [];
        state.flagAck = null;
      }
    }
  }

  if (body.motion === "moving" || body.motion === "stopped") {
    state.motion = body.motion;
    if (body.motion === "moving") state.forceStoppedAlert = false;
  }

  if (body.flagStatus === "red" || body.flagStatus === "green") {
    if (body.flagStatus === "red" && state.mode !== "stage") {
      state.mode = "stage";
      state.crewStatus = null;
    }
    const next = body.flagStatus;
    if (next === "red") {
      const targets = normalizeTargets(body.flagTargets);
      if (!targets.length) {
        throw Object.assign(new Error("Select at least one car to receive the red flag."), {
          statusCode: 400,
        });
      }
      const known = new Set(state.cars.map((c) => c.id));
      const valid = targets.filter((id) => known.has(id));
      if (!valid.length) {
        throw Object.assign(new Error("Select at least one sandbox car."), { statusCode: 400 });
      }
      state.flagStatus = "red";
      state.flagTargets = valid;
      state.flagTs = Date.now();
      state.flagAck = null;
    } else {
      state.flagStatus = "green";
      state.flagTargets = [];
      state.flagTs = Date.now();
      state.flagAck = null;
    }
  } else if (Object.prototype.hasOwnProperty.call(body, "flagTargets") && state.flagStatus === "red") {
    const targets = normalizeTargets(body.flagTargets);
    if (!targets.length) {
      throw Object.assign(new Error("Select at least one car to receive the red flag."), {
        statusCode: 400,
      });
    }
    const known = new Set(state.cars.map((c) => c.id));
    const valid = targets.filter((id) => known.has(id));
    if (!valid.length) {
      throw Object.assign(new Error("Select at least one sandbox car."), { statusCode: 400 });
    }
    state.flagTargets = valid;
    state.flagTs = Date.now();
    state.flagAck = null;
  }

  if (body.crewStatus === "ok" || body.crewStatus === "sos") {
    setCrewStatus(body.crewStatus);
  }

  if (body.forceStoppedAlert === true) {
    state.mode = "stage";
    state.motion = "stopped";
    state.forceStoppedAlert = true;
  } else if (body.forceStoppedAlert === false) {
    state.forceStoppedAlert = false;
  }

  return touch();
}

module.exports = {
  snapshot,
  reset,
  setCrewStatus,
  ackFlag,
  applyHqPatch,
  TEST_STAGE_ID,
  TEST_ROAD_ID,
};
