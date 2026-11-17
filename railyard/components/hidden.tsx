/** Hidden form fields: CSRF token plus any extra values. */
export function Hidden({ csrf, values }: { csrf: string; values?: Record<string, string> }) {
  return (
    <>
      <input type="hidden" name="csrf" value={csrf} />
      {Object.entries(values ?? {}).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
    </>
  );
}
