const ARTIFACT_KEY = /^[0-9a-f]{32}\.[a-z0-9]{1,10}$/;
const EXTENSION = /^[a-z0-9]{1,10}$/;

export function createArtifactKey(extension: string): string {
  const normalizedExtension = extension.toLowerCase();
  if (!EXTENSION.test(normalizedExtension)) throw new TypeError("Invalid artifact extension");

  const id = crypto.randomUUID().replaceAll("-", "");
  return `${id}.${normalizedExtension}`;
}

export function validateArtifactKey(key: string): string {
  if (!ARTIFACT_KEY.test(key)) throw new TypeError("Invalid artifact key");
  return key;
}
