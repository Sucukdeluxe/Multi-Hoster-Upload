function createUploadStartReservation() {
  let active = null;

  return {
    acquire() {
      if (active) return null;
      const state = { cancelled: false, released: false };
      const lease = {
        isCancelled: () => state.cancelled,
        release() {
          if (state.released) return;
          state.released = true;
          if (active && active.lease === lease) active = null;
        }
      };
      active = { lease, state };
      return lease;
    },
    cancel() {
      if (!active) return false;
      active.state.cancelled = true;
      return true;
    },
    isActive: () => active !== null
  };
}

module.exports = { createUploadStartReservation };
