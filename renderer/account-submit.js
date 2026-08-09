(function (scope) {
  function getAccountSubmitLabel() {
    return 'Prüfen und speichern';
  }

  async function submitValidatedAccount({ validate, commit, afterCommit, isCurrent }) {
    let validation;
    try {
      validation = await validate();
    } catch (error) {
      return { status: 'error', error };
    }

    try {
      if (!isCurrent()) return { status: 'stale', validation };
    } catch (error) {
      return { status: 'error', error, validation };
    }
    if (validation && validation.status === 'otp_required') {
      return { status: 'otp_required', validation };
    }
    if (!validation || (validation.status !== 'ok' && validation.status !== 'warn')) {
      return { status: 'rejected', validation };
    }

    let value;
    try {
      value = await commit(validation);
    } catch (error) {
      return { status: 'error', error, validation };
    }

    let postCommitError;
    if (typeof afterCommit === 'function') {
      try {
        await afterCommit(value, validation);
      } catch (error) {
        postCommitError = error;
      }
    }

    const committedResult = { status: 'committed', committed: true, validation, value };
    if (postCommitError) committedResult.postCommitError = postCommitError;
    try {
      if (!isCurrent()) return { ...committedResult, status: 'stale' };
    } catch {
      return { ...committedResult, status: 'stale' };
    }
    return committedResult;
  }

  function createAccountSubmitter() {
    let pending = null;
    return {
      isBusy() {
        return pending !== null;
      },
      submit(options) {
        if (pending) return null;
        const operation = submitValidatedAccount(options);
        const tracked = operation.finally(() => {
          if (pending === tracked) pending = null;
        });
        pending = tracked;
        return tracked;
      }
    };
  }

  const accountSubmit = { createAccountSubmitter, getAccountSubmitLabel, submitValidatedAccount };
  if (typeof module !== 'undefined' && module.exports) module.exports = accountSubmit;
  if (scope) scope.AccountSubmit = accountSubmit;
})(typeof window !== 'undefined' ? window : globalThis);
