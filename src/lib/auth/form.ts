/** Read a text field from a POSTed form; anything else (files, missing, oversized) becomes ''. */
export function field(form: FormData, name: string, max = 400): string {
  const v = form.get(name);
  return typeof v === 'string' && v.length <= max ? v : '';
}

export async function readForm(request: Request): Promise<FormData | null> {
  try {
    return await request.formData();
  } catch {
    return null;
  }
}
