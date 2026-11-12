# TraceCode Studio: compiler, NASM, linker, Graphviz and the web server in one image.
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential flex bison nasm binutils graphviz make python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .
RUN make

# Listen on all interfaces inside the container. Set TRACECODE_PASSWORD when the app is public.
ENV HOST=0.0.0.0 PORT=8000
EXPOSE 8000
CMD ["python3", "-I", "backend/server.py"]
