function safeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function quarantineObjectKey(
  input: { tenantId: string; matterId: string; checksum: string },
  uploadId = crypto.randomUUID(),
) {
  return `${safeSegment(input.tenantId)}/${safeSegment(input.matterId)}/quarantine/${input.checksum}/${safeSegment(uploadId)}`;
}
