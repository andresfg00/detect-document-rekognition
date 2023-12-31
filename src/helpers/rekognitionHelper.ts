import {
  DetectLabelsCommandInput,
  DetectTextCommand,
  Rekognition,
  TextDetection,
} from '@aws-sdk/client-rekognition';

import {
  CUSTOM_MIN_INE_PHRASE_CONFIDENCE,
  CUSTOM_MIN_INE_WORD_CONFIDENCE,
  CUSTOM_MIN_PASSPORT_PHRASE_CONFIDENCE,
  CUSTOM_MIN_PASSPORT_WORD_CONFIDENCE,
  REGION,
  REKOGNITION_MIN_DOCUMENT_CONFIDENCE,
  REKOGNITION_MIN_TEXT_CONFIDENCE,
  S3_BUCKET_NAME,
  logger,
} from '../config/projectConfig';
import {
  AllowedINEPhrases,
  AllowedINEWords,
  AllowedPassportPhrases,
  AllowedPassportWords,
  AllowedRekognitionLabels,
  DriversLicenceWords,
} from '../enums/RekognitionEnums';
import {
  LabelsDetectionException,
  LabelsInvalidDocumentException,
  LabelsNotFoundException,
  TextNotFoundException,
  TextNotValidException,
  TextVerificationException,
} from '../exceptions/RekognitionExceptions';
import { LabelConfidence, TaskResult } from '../interfaces/Job';
import { BackendCustomException } from '../exceptions/GeneralExceptions';
import { AnalysisStatuses, TextValidationResponse } from '../enums/JobEnums';

export const rekognitionClient = new Rekognition({
  region: REGION,
});

export async function detectLabels(
  s3FileKey: string,
  bucketName = S3_BUCKET_NAME
): Promise<TaskResult<LabelConfidence[]>> {
  const labelConfidences: LabelConfidence[] = [];
  try {
    const detectCustomLabelsInput: DetectLabelsCommandInput = {
      Image: {
        S3Object: {
          Bucket: bucketName,
          Name: s3FileKey,
        },
      },
    };

    const { Labels } = await rekognitionClient.detectLabels(detectCustomLabelsInput);

    if (!Labels) {
      throw new LabelsNotFoundException();
    }

    const allowedLabels = Object.values(AllowedRekognitionLabels);

    const areLabelsValid = allowedLabels.every((allowedLabel) => {
      const labelConfidence: LabelConfidence = { name: allowedLabel, value: 0 };
      const isLabelValid = Labels.some(({ Name, Confidence }) => {
        const isSameLabel = Name === allowedLabel;

        if (isSameLabel) {
          labelConfidence.value = Confidence as number;
        }

        return (
          isSameLabel &&
          (Confidence as number) >= REKOGNITION_MIN_DOCUMENT_CONFIDENCE
        );
      });
      labelConfidences.push(labelConfidence);

      return isLabelValid;
    });

    if (!areLabelsValid) {
      throw new LabelsInvalidDocumentException();
    }

    return { value: labelConfidences };
  } catch (error) {
    logger.error(error as Error);
    if (error instanceof BackendCustomException) {
      return { value: labelConfidences, error };
    } else {
      throw new LabelsDetectionException('', error as Error);
    }
  }
}

export async function verifyTextInImage(
  fileKey: string,
  bucketName = S3_BUCKET_NAME
): Promise<TextValidationResponse & { error?: BackendCustomException }> {

  try {
    const detectTextCommand = new DetectTextCommand({
      Image: {
        S3Object: {
          Bucket: bucketName,
          Name: fileKey,
        },
      },
      Filters: {
        WordFilter: {
          MinConfidence: +REKOGNITION_MIN_TEXT_CONFIDENCE,
        },
      },
    });

    const { TextDetections } = await rekognitionClient.send(detectTextCommand);

    if (!TextDetections || TextDetections.length < 1) {
      return {
        analysisStatus: AnalysisStatuses.INVALID_TEXT,
        validity: 0,
        error: new TextNotFoundException(),
      };
    }

    let analysisStatus = AnalysisStatuses.INVALID_DOCUMENT;
    let validity = 0;
    const INEWordsValidity = areWordsValid(
      TextDetections,
      Object.values(AllowedINEWords)
    );

    if (INEWordsValidity >= +CUSTOM_MIN_INE_WORD_CONFIDENCE) {
      analysisStatus = AnalysisStatuses.PROBABLY_INE;
      validity = getValidity(+CUSTOM_MIN_INE_WORD_CONFIDENCE);
      const INEPhrasesValidity = areWordsValid(
        TextDetections,
        Object.values(AllowedINEPhrases)
      );
      if (INEPhrasesValidity >= +CUSTOM_MIN_INE_PHRASE_CONFIDENCE) {
        analysisStatus = AnalysisStatuses.VALID_INE;
        validity = getValidity(+CUSTOM_MIN_INE_PHRASE_CONFIDENCE);
      }

      return { analysisStatus, validity };
    }

    const driversLicenseValidity = areWordsValid(
      TextDetections,
      Object.values(DriversLicenceWords)
    );

    if (driversLicenseValidity > 0) {
      return { analysisStatus, validity, error: new TextNotValidException() };
    }

    const passportWordsValidity = areWordsValid(
      TextDetections,
      Object.values(AllowedPassportWords)
    );

    if (passportWordsValidity >= +CUSTOM_MIN_PASSPORT_WORD_CONFIDENCE) {
      analysisStatus = AnalysisStatuses.PROBABLY_PASSPORT;
      validity = getValidity(+CUSTOM_MIN_PASSPORT_WORD_CONFIDENCE);
      const passportPhrasesValidity = areWordsValid(
        TextDetections,
        Object.values(AllowedPassportPhrases)
      );
      if (passportPhrasesValidity >= +CUSTOM_MIN_PASSPORT_PHRASE_CONFIDENCE) {
        validity = getValidity(+CUSTOM_MIN_PASSPORT_PHRASE_CONFIDENCE);
        analysisStatus = AnalysisStatuses.VALID_PASSPORT;
      }
      return { analysisStatus, validity };
    }

    return { analysisStatus, validity, error: new TextNotValidException() };
  } catch (error) {
    logger.error(error as Error);
    if (error instanceof BackendCustomException) {
      throw error;
    } else {
      throw new TextVerificationException('', error as Error);
    }
  }
}

export function areWordsValid<T>(
  toBeCheckedWords: TextDetection[],
  allowedWords: T[]
): number {
  const allowedWordsLength = allowedWords.length;
  const filteredWords = toBeCheckedWords.filter(({ DetectedText }) => {
    const allowedWordIndex = allowedWords.findIndex(
      (allowedWord) => allowedWord === DetectedText?.toUpperCase()
    );

    if (allowedWordIndex > -1) {
      allowedWords.splice(allowedWordIndex, 1);
      return true;
    }
    return false;
  });

  const validity = (filteredWords.length / allowedWordsLength) * 100;

  return validity;
}

export function getValidity(minValidity: number): number {
  let min = 90;
  if (minValidity < 90) {
    min = minValidity + 10;
  }
  return +(Math.random() * (100 - min) + min).toFixed(2);
}
