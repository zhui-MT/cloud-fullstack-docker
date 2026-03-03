function diffConfigs(fromConfig, toConfig) {
  const changes = [];
  walkDiff(fromConfig, toConfig, '', changes);
  return {
    same: changes.length === 0,
    changes,
  };
}

function walkDiff(fromValue, toValue, path, changes) {
  if (Object.is(fromValue, toValue)) {
    return;
  }

  if (Array.isArray(fromValue) && Array.isArray(toValue)) {
    const max = Math.max(fromValue.length, toValue.length);
    for (let i = 0; i < max; i += 1) {
      const nextPath = `${path}[${i}]`;
      if (i >= fromValue.length || i >= toValue.length) {
        changes.push({
          path: nextPath,
          from: fromValue[i],
          to: toValue[i],
        });
        continue;
      }
      walkDiff(fromValue[i], toValue[i], nextPath, changes);
    }
    return;
  }

  if (isPlainObject(fromValue) && isPlainObject(toValue)) {
    const keys = Array.from(new Set([...Object.keys(fromValue), ...Object.keys(toValue)])).sort();
    for (const key of keys) {
      const nextPath = path ? `${path}.${key}` : key;
      walkDiff(fromValue[key], toValue[key], nextPath, changes);
    }
    return;
  }

  changes.push({
    path: path || '$',
    from: fromValue,
    to: toValue,
  });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

module.exports = {
  diffConfigs,
};
