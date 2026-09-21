/**
 * Isolated in-memory sandbox for Test mode.
 * Never reads or writes rally_cars, rally_sections, or liveSections().
 */
const TEST_STAGE_ID = "test-stage";
const TEST_ROAD_ID = "test-road";
const MOVING_SPEED_MPS = 22.2;

function defaultState() {
  return {
    mode: "road",
    stageName: "SS Test",
    roadName: "Liaison Test",
    flagStatus: "green",
    flagTs: 0,
    crewStatus: null,
    flagAck: null,
    motion: "moving",
    forceStoppedAlert: false,
    updatedAt: Date.now(),
  };
}

let state = defaultState();

function sectionFor(current) {
  if (current.mode === "stage") {
    return {
      id: TEST_STAGE_ID,
      type: "stage",
      name: current.stageName,
      label: current.stageName,
      flagStatus: current.flagStatus === "red" ? "red" : "green",
      flagTs: Number(current.flagTs) || 0,
    };
  }
  return {
    id: TEST_ROAD_ID,
    type: "road",
    name: current.roadName,
    label: current.roadName,
  };
}

function snapshot() {
  const section = sectionFor(state);
  const onStage = state.mode === "stage";
  const flagStatus = onStage && state.flagStatus === "red" ? "red" : "green";
  const flagTs = Number(state.flagTs) || 0;
  const flagAcked =
    flagStatus !== "red" ||
    (state.flagAck != null && Number(state.flagAck.flagTs) === flagTs);
  const stopped = state.motion === "stopped";
  return {
    ok: true,
    test: true,
    tracking: true,
    carNumber: "99",
    driverName: "TEST CREW",
    section,
    crewStatus: state.crewStatus,
    flagStatus,
    flagTs,
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
    state.flagAck = null;
  }
  state.crewStatus = {
    status: value,
    ts: Date.now(),
    stageId: TEST_STAGE_ID,
    stageName: state.stageName,
  };
  state.forceStoppedAlert = false;
  return touch();
}

function ackFlag() {
  if (state.mode !== "stage" || state.flagStatus !== "red") {
    throw Object.assign(new Error("Test car is not on a red-flagged stage."), { statusCode: 400 });
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

  if (body.mode === "road" || body.mode === "stage") {
    const prev = state.mode;
    state.mode = body.mode;
    if (prev !== body.mode) {
      state.crewStatus = null;
      state.forceStoppedAlert = false;
      if (body.mode === "road") {
        state.flagStatus = "green";
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
    const isNew = next !== state.flagStatus || next === "red";
    state.flagStatus = next;
    state.flagTs = Date.now();
    if (next === "green" || isNew) state.flagAck = null;
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
