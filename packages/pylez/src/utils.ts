const _underscoreOnlyRegEx = /^[_]+$/;

export const isUnderscoreOnlyName = (name: string) => name.match(_underscoreOnlyRegEx);
