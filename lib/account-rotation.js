function enabledAccountsFor(hosters, hoster, hasCreds) {
  const list = hosters && hosters[hoster];
  if (!Array.isArray(list)) return [];
  return list.filter(a => a && a.enabled !== false && hasCreds(hoster, a));
}

function createAccountPicker({ hosters, hosterSettings, hasCreds, indices }) {
  const rotIdx = Object.assign(Object.create(null), indices || {});
  let dirty = false;
  function pick(hoster) {
    const enabled = enabledAccountsFor(hosters, hoster, hasCreds);
    if (enabled.length === 0) return null;
    const hs = (hosterSettings && hosterSettings[hoster]) || {};
    if (hs.rotateAccounts === true && enabled.length > 1) {
      const cursor = Number.isFinite(rotIdx[hoster]) ? rotIdx[hoster] : 0;
      rotIdx[hoster] = cursor + 1;
      dirty = true;
      return enabled[cursor % enabled.length];
    }
    return enabled[0];
  }
  pick.indices = () => ({ ...rotIdx });
  pick.dirty = () => dirty;
  return pick;
}

module.exports = { createAccountPicker, enabledAccountsFor };
