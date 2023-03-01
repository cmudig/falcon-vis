""" Backend server for the frontend app 
This file contains the endpoints that can be called via HTTP
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import duckdb
import pyarrow as pa
from io import BytesIO
from fastapi.responses import Response

BACKEND_HOST = "localhost"
BACKEND_PORT = 8000
FRONTEND_HOST = "localhost"
FRONTEND_PORT = 5173

app = FastAPI()

# without this, the frontend errors out
# when making requests to the backend
port_url = lambda url, port: f"http://{url}:{port}"
origins = [
    port_url("localhost", FRONTEND_PORT),
    port_url("127.0.0.1", FRONTEND_PORT),
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# SETUP GLOBAL CONNECTION TO THE DATABASE
con = duckdb.connect(":memory:")
con.query(
    """CREATE TABLE diffusiondb AS
    SELECT * FROM read_parquet('data/diffusiondb.parquet')
    """
)


@app.get("/query/{sql_query:path}")
async def query(sql_query: str):
    global con
    sql_query = sql_query.replace("count(*)", "count(*)::INT")
    result = con.query(sql_query).arrow()
    return Response(table_to_bytes(result), media_type="application/octet-stream")


def table_to_bytes(table: pa.Table):
    sink = pa.BufferOutputStream()
    with pa.RecordBatchStreamWriter(sink, table.schema) as writer:
        writer.write_table(table)
    file_in_memory = BytesIO(sink.getvalue()).getvalue()
    return file_in_memory


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, port=BACKEND_PORT, host=BACKEND_HOST)
