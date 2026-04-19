import asyncio
import serial
import websockets
import json

PORT = "COM8"
BAUD = 115200

connected_clients = set()
serial_port = None

async def handler(ws):
    print("Dashboard connected")
    connected_clients.add(ws)
    try:
        async for message in ws:
            if serial_port and serial_port.is_open:
                serial_port.write((message.strip() + "\n").encode("utf-8"))
                print(f"Sent to ESP32: {message.strip()}")
    except websockets.exceptions.ConnectionClosedError:
        pass
    finally:
        connected_clients.discard(ws)
        print("Dashboard disconnected")

async def read_serial():
    global serial_port
    loop = asyncio.get_event_loop()
    serial_port = serial.Serial(PORT, BAUD, timeout=1)
    print(f"Reading from {PORT} at {BAUD} baud...")
    while True:
        line = await loop.run_in_executor(None, serial_port.readline)
        line = line.decode("utf-8", errors="ignore").strip()
        if line.startswith("{"):
            try:
                json.loads(line)
                if connected_clients:
                    await asyncio.gather(*[ws.send(line) for ws in connected_clients])
            except:
                pass

async def main():
    print("WebSocket bridge running on ws://localhost:8765")
    async with websockets.serve(handler, "localhost", 8765):
        await read_serial()

asyncio.run(main())