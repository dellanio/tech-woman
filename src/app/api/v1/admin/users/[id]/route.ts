// RED stub (WP-002 Task 3 slice C): sem comportamento.
export const runtime = 'nodejs';
export async function GET(): Promise<Response> { return new Response(null, { status: 501 }); }
export async function PATCH(): Promise<Response> { return new Response(null, { status: 501 }); }
export async function DELETE(): Promise<Response> { return new Response(null, { status: 501 }); }
