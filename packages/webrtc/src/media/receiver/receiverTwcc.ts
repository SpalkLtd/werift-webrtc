import {
  PacketStatus,
  RecvDelta,
  RtcpTransportLayerFeedback,
  RunLengthChunk,
  TransportWideCC,
  StatusVectorChunk,
} from "../../../../rtp/src";
import { sleep } from "../../../../sctp/src/helper";
import { RTCDtlsTransport } from "../../transport/dtls";
import { microTime, uint16Add, uint24, uint8Add } from "../../utils";

type ExtensionInfo = { tsn: number; timestamp: number };

export class ReceiverTWCC {
  extensionInfo: {
    [tsn: number]: ExtensionInfo;
  } = {};
  twccRunning = false;
  /** uint8 */
  fbPktCount = 0;
  lastTimestamp?: number;

  constructor(
    private dtlsTransport: RTCDtlsTransport,
    private rtcpSsrc: number,
    private mediaSourceSsrc: number
  ) {
    this.runTWCC();
  }

  handleTWCC(transportSequenceNumber: number) {
    this.extensionInfo[transportSequenceNumber] = {
      tsn: transportSequenceNumber,
      timestamp: microTime(),
    };

    if (Object.keys(this.extensionInfo).length > 10) {
      this.sendTWCC();
    }
  }

  private async runTWCC() {
    while (this.twccRunning) {
      this.sendTWCC();
      await sleep(100);
    }
  }

  private sendTWCC() {
    if (Object.keys(this.extensionInfo).length === 0) return;
    const extensionsArr = Object.values(this.extensionInfo).sort(
      (a, b) => a.tsn - b.tsn
    );

    const minTSN = extensionsArr[0].tsn;
    const maxTSN = extensionsArr.slice(-1)[0].tsn;

    const packetChunks: (RunLengthChunk | StatusVectorChunk)[] = [];
    const baseSequenceNumber = extensionsArr[0].tsn;
    const packetStatusCount = uint16Add(maxTSN - minTSN, 1);
    /**micro sec */
    let referenceTime!: number;
    let lastPacketStatus: { status: PacketStatus; minTSN: number } | undefined;
    const recvDeltas: RecvDelta[] = [];

    for (let i = minTSN; i <= maxTSN; i++) {
      /**micro sec */
      const timestamp = this.extensionInfo[i]?.timestamp;

      if (timestamp) {
        if (!this.lastTimestamp) {
          this.lastTimestamp = timestamp;
        }
        if (!referenceTime) {
          referenceTime = this.lastTimestamp;
        }

        const delta = timestamp - this.lastTimestamp;
        this.lastTimestamp = timestamp;

        const recvDelta = new RecvDelta({
          delta: Number(delta),
        });
        recvDelta.parseDelta();
        recvDeltas.push(recvDelta);

        // when status changed
        if (
          lastPacketStatus != undefined &&
          lastPacketStatus.status !== recvDelta.type
        ) {
          packetChunks.push(
            new RunLengthChunk({
              packetStatus: lastPacketStatus.status,
              runLength: i - lastPacketStatus.minTSN,
            })
          );
          lastPacketStatus = { minTSN: i, status: recvDelta.type! };
        }
        // last status
        if (i === maxTSN) {
          if (lastPacketStatus != undefined) {
            packetChunks.push(
              new RunLengthChunk({
                packetStatus: lastPacketStatus.status,
                runLength: i - lastPacketStatus.minTSN + 1,
              })
            );
          } else {
            packetChunks.push(
              new RunLengthChunk({
                packetStatus: recvDelta.type,
                runLength: 1,
              })
            );
          }
        }

        if (lastPacketStatus == undefined) {
          lastPacketStatus = { minTSN: i, status: recvDelta.type! };
        }
      }
    }

    if (!referenceTime) {
      return;
    }

    const packet = new RtcpTransportLayerFeedback({
      feedback: new TransportWideCC({
        senderSsrc: this.rtcpSsrc,
        mediaSourceSsrc: this.mediaSourceSsrc,
        baseSequenceNumber,
        packetStatusCount,
        referenceTime: uint24(Math.floor(referenceTime / 1000 / 64)),
        fbPktCount: this.fbPktCount,
        recvDeltas,
        packetChunks,
      }),
    });

    this.dtlsTransport.sendRtcp([packet]).catch((err) => {
      console.log(err);
    });
    this.extensionInfo = {};
    this.fbPktCount = uint8Add(this.fbPktCount, 1);
  }
}