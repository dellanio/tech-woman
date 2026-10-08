export async function POST() { const response = Response.json({ok:true}); response.headers.append('Set-Cookie','tw_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'); return response; }
